/**
 * Read-only audit for untrusted external skill packs.
 *
 * This module never executes pack scripts, writes the signed skill ledger, or
 * grants routing/prompt authority. A passing report only means the pack is a
 * well-formed candidate for later sandboxed behavioral evaluation.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Lexer } from 'marked';

const MAX_SKILLS = 128;
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FIXTURE_ENTRIES = 2_048;
const MAX_DESCRIPTION_CHARS = 1_024;
const MAX_TRIGGER_CASES = 64;
const MAX_BEHAVIORAL_CASES = 32;
const MAX_CASE_TEXT_CHARS = 4_096;
const MAX_EXPECTATIONS = 32;
const MAX_FIXTURE_REFS = 32;
const MAX_TOP_K = 5;
const MIN_POSITIVE_TRIGGERS = 3;
const MIN_NEGATIVE_TRIGGERS = 2;
const MIN_BEHAVIORAL_EVALS = 1;
const MIN_RANK_ONE_RATE = 0.8;
const COLLISION_WARNING = 0.5;
const COLLISION_ERROR = 0.75;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BUN_RUNTIME = typeof process.versions.bun === 'string';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'before', 'by', 'for',
  'from', 'in', 'into', 'is', 'it', 'its', 'my', 'need', 'needs', 'of', 'on',
  'or', 'our', 'so', 'that', 'the', 'them', 'this', 'to', 'use', 'want', 'we',
  'when', 'with', 'you', 'your', 'help', 'me', 'i',
]);

export interface ExternalSkillAuditEntry {
  name: string;
  contentHash: string;
  descriptionHash: string;
  bytes: number;
  sections: {
    whenToUse: boolean;
    process: boolean;
    rationalizations: boolean;
    redFlags: boolean;
    verification: boolean;
  };
  triggerCases: {
    positive: number;
    negative: number;
    behavioral: number;
  };
  routing: {
    passed: boolean;
    topKPassed: number;
    rankOnePassed: number;
    rankOneRate: number | null;
    negativePassed: number;
  };
}

export type ExternalSkillAuditIssueCode =
  | 'invalid-eval-file'
  | 'incomplete-eval-contract'
  | 'invalid-pack-root'
  | 'invalid-skills-directory'
  | 'skills-directory-escapes-pack'
  | 'pack-unavailable-or-unsafe'
  | 'skills-directory-unreadable'
  | 'skill-directory-entry-limit'
  | 'skill-count-limit'
  | 'invalid-skill-directory'
  | 'skill-file-unreadable'
  | 'invalid-skill-frontmatter'
  | 'incomplete-workflow-sections'
  | 'missing-adversarial-sections'
  | 'no-valid-skills'
  | 'unexpected-eval-entry'
  | 'invalid-eval-case-name'
  | 'orphan-eval-file'
  | 'eval-cases-directory-unavailable'
  | 'missing-eval-file'
  | 'unknown-negative-owner'
  | 'duplicate-cross-skill-trigger'
  | 'audit-worker-timeout'
  | 'audit-worker-failed';

export type ExternalSkillPromotionBlocker =
  | 'external-content-quarantined'
  | 'source-provenance-required'
  | 'immutable-source-snapshot-required'
  | 'license-review-required'
  | 'behavioral-evidence-required'
  | 'verified-outcome-required';

export interface ExternalSkillAuditIssue {
  level: 'error' | 'warning';
  code: ExternalSkillAuditIssueCode;
  skill?: string;
}

export interface ExternalSkillCollision {
  left: string;
  right: string;
  similarity: number;
  level: 'error' | 'warning';
}

export interface ExternalSkillAuditReport {
  schemaVersion: 1;
  mode: 'quarantine';
  packDigest: string | null;
  skillCount: number;
  caseFileCount: number;
  bytesRead: number;
  structural: {
    passed: boolean;
    errors: number;
    warnings: number;
  };
  routing: {
    passed: boolean;
    positivePrompts: number;
    topKPassed: number;
    rankOnePassed: number;
    rankOneRate: number | null;
    negativePrompts: number;
    negativePassed: number;
    collisionErrors: number;
    collisionWarnings: number;
    thresholds: {
      minimumRankOneRate: number;
      collisionWarning: number;
      collisionError: number;
    };
  };
  behavioral: {
    state: 'declared' | 'missing' | 'invalid';
    declaredCases: number;
  };
  trialReady: boolean;
  promotion: {
    eligible: false;
    blockers: ExternalSkillPromotionBlocker[];
  };
  issues: ExternalSkillAuditIssue[];
  collisions: ExternalSkillCollision[];
  skills: ExternalSkillAuditEntry[];
}

interface LoadedSkill {
  name: string;
  description: string;
  contentHash: string;
  descriptionHash: string;
  bytes: number;
  sections: ExternalSkillAuditEntry['sections'];
}

interface TriggerPositive {
  prompt: string;
  topK: number;
}

interface TriggerNegative {
  prompt: string;
  owner?: string;
}

interface LoadedCases {
  positive: TriggerPositive[];
  negative: TriggerNegative[];
  behavioral: number;
  behavioralValid: boolean;
  valid: boolean;
}

interface AuditState {
  bytesRead: number;
  issues: ExternalSkillAuditIssue[];
  fileCache: Map<string, Buffer>;
  treeDigests: Map<string, string>;
  snapshotFiles: Map<string, Buffer>;
  snapshotTreeDigests: Map<string, string>;
  snapshotDirectoryEntries: Map<string, string[]>;
  snapshotPathKinds: Map<string, 'file' | 'directory' | 'symlink'>;
  fixtureEntriesObserved: number;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function asciiCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function roundedRate(value: number | null | undefined): number | null {
  return value === null || value === undefined
    ? null
    : Math.round(value * 1_000_000) / 1_000_000;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function decodePathText(value: string | Buffer): { text: string; bytes: Buffer } {
  if (typeof value === 'string') {
    if (value.includes('\ufffd')) throw new Error('invalid-path-utf8');
    return { text: value, bytes: Buffer.from(value, 'utf8') };
  }
  return { text: decodeUtf8(value), bytes: value };
}

function issue(
  state: AuditState,
  level: ExternalSkillAuditIssue['level'],
  code: ExternalSkillAuditIssueCode,
  skill?: string,
): void {
  state.issues.push({ level, code, ...(skill ? { skill } : {}) });
}

function inside(root: string, candidate: string): boolean {
  const back = relative(root, candidate);
  return back === '' || (!back.startsWith(`..${sep}`) && back !== '..' && !isAbsolute(back));
}

function readBoundedRegularBytes(path: string, root: string, state: AuditState): Buffer {
  const canonicalParent = realpathSync(dirname(path));
  if (!inside(root, canonicalParent)) throw new Error('path-parent-escapes-pack');
  const canonicalPath = realpathSync(path);
  if (!inside(root, canonicalPath)) throw new Error('path-escapes-pack');
  const cached = state.fileCache.get(canonicalPath);
  if (cached) return cached;
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error('path-not-private-regular-file');
  }
  if (before.size > BigInt(MAX_FILE_BYTES)) throw new Error('file-size-limit');
  if (state.bytesRead + Number(before.size) > MAX_TOTAL_BYTES) throw new Error('pack-size-limit');

  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeNs !== before.mtimeNs
      || opened.ctimeNs !== before.ctimeNs
    ) {
      throw new Error('file-identity-changed');
    }
    if (opened.size > BigInt(MAX_FILE_BYTES)) throw new Error('file-size-limit');
    if (state.bytesRead + Number(opened.size) > MAX_TOTAL_BYTES) throw new Error('pack-size-limit');
    const size = Number(opened.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, offset, size - offset, offset);
      if (count <= 0) throw new Error('file-short-read');
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
    ) throw new Error('file-mutated-during-read');
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || pathAfter.nlink !== 1n
      || pathAfter.dev !== opened.dev
      || pathAfter.ino !== opened.ino
    ) throw new Error('file-path-replaced-during-read');
    state.bytesRead += size;
    state.fileCache.set(canonicalPath, buffer);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function digestTreePath(
  path: string,
  containmentRoot: string,
  root: string,
  state: AuditState,
  depth = 0,
  allowInternalSymlinks = false,
): string {
  if (depth > 12) throw new Error('tree-depth-limit');
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink()) {
    if (!allowInternalSymlinks) throw new Error('tree-symlink');
    const decodedLinkTarget = decodePathText(readlinkSync(path, {
      encoding: BUN_RUNTIME ? 'utf8' : 'buffer' as BufferEncoding,
    }));
    const { text: linkTarget, bytes: rawLinkTarget } = decodedLinkTarget;
    if (isAbsolute(linkTarget)) throw new Error('absolute-tree-symlink');
    const target = realpathSync(resolve(dirname(path), linkTarget));
    if (!inside(containmentRoot, target)) throw new Error('tree-symlink-escapes-pack');
    const excludedGitRoot = join(containmentRoot, '.git');
    if (inside(excludedGitRoot, target)) throw new Error('tree-symlink-target-excluded');
    const resolvedTarget = Buffer.from(relative(containmentRoot, target), 'utf8');
    const digest = sha256(Buffer.concat([
      Buffer.from(`symlink\0${rawLinkTarget.length}\0`, 'utf8'),
      rawLinkTarget,
      Buffer.from(`\0${resolvedTarget.length}\0`, 'utf8'),
      resolvedTarget,
    ]));
    state.snapshotPathKinds.set(path, 'symlink');
    state.snapshotTreeDigests.set(path, digest);
    return digest;
  }
  const canonical = realpathSync(path);
  if (!inside(containmentRoot, canonical)) throw new Error('tree-escapes-pack');
  if ((stat.mode & 0o7000n) !== 0n) throw new Error('tree-special-permission-bits');
  const cached = state.treeDigests.get(canonical);
  if (cached) return cached;
  if (stat.isFile()) {
    const bytes = readBoundedRegularBytes(path, root, state);
    const afterRead = lstatSync(path, { bigint: true });
    if (
      !afterRead.isFile()
      || afterRead.dev !== stat.dev
      || afterRead.ino !== stat.ino
      || afterRead.mode !== stat.mode
      || afterRead.size !== stat.size
      || afterRead.mtimeNs !== stat.mtimeNs
      || afterRead.ctimeNs !== stat.ctimeNs
    ) throw new Error('file-metadata-mutated-during-digest');
    const mode = Number(stat.mode & 0o777n).toString(8).padStart(3, '0');
    const digest = sha256(Buffer.concat([
      Buffer.from(`file\0${mode}\0${bytes.length}\0`, 'utf8'),
      bytes,
    ]));
    state.treeDigests.set(canonical, digest);
    state.snapshotFiles.set(path, bytes);
    state.snapshotPathKinds.set(path, 'file');
    state.snapshotTreeDigests.set(path, digest);
    return digest;
  }
  if (!stat.isDirectory()) throw new Error('tree-not-regular');
  const entries: Array<{ name: string; rawName: Buffer }> = [];
  const directory = opendirSync(path, {
    encoding: BUN_RUNTIME ? 'utf8' : 'buffer' as BufferEncoding,
  });
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (entries.length >= MAX_DIRECTORY_ENTRIES) throw new Error('tree-entry-limit');
      const decodedName = decodePathText(entry.name);
      entries.push({ name: decodedName.text, rawName: decodedName.bytes });
    }
  } finally {
    directory.closeSync();
  }
  entries.sort((left, right) => Buffer.compare(left.rawName, right.rawName));
  state.fixtureEntriesObserved += entries.length;
  if (state.fixtureEntriesObserved > MAX_FIXTURE_ENTRIES) throw new Error('tree-total-entry-limit');
  const parts: Array<{ rawName: Buffer; digest: string }> = [];
  for (const entry of entries) {
    if (depth === 0 && entry.name === '.git') {
      const gitStat = lstatSync(join(path, entry.name), { bigint: true });
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
        throw new Error('invalid-excluded-git-entry');
      }
      continue;
    }
    const child = join(path, entry.name);
    const childDigest = digestTreePath(
      child,
      containmentRoot,
      root,
      state,
      depth + 1,
      allowInternalSymlinks,
    );
    parts.push({ rawName: entry.rawName, digest: childDigest });
  }
  const after = lstatSync(path, { bigint: true });
  if (
    !after.isDirectory()
    || after.dev !== stat.dev
    || after.ino !== stat.ino
    || after.mtimeNs !== stat.mtimeNs
    || after.ctimeNs !== stat.ctimeNs
  ) throw new Error('directory-mutated-during-read');
  const mode = Number(stat.mode & 0o777n).toString(8).padStart(3, '0');
  const hasher = createHash('sha256').update(`directory\0${mode}\0${parts.length}\0`);
  for (const part of parts) {
    hasher.update(`${part.rawName.length}\0`);
    hasher.update(part.rawName);
    hasher.update(`\0${part.digest}`);
  }
  const digest = hasher.digest('hex');
  state.treeDigests.set(canonical, digest);
  state.snapshotDirectoryEntries.set(path, entries.map((entry) => entry.name));
  state.snapshotPathKinds.set(path, 'directory');
  state.snapshotTreeDigests.set(path, digest);
  return digest;
}

function parseFrontmatter(source: string): { name: string; description: string } | null {
  const block = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!block) return null;
  const values = new Map<string, string>();
  for (const line of block[1]!.split(/\r?\n/)) {
    const match = line.match(/^(name|description):[ \t]*(.*)$/);
    if (!match || values.has(match[1]!)) return null;
    values.set(match[1]!, match[2]!.trim());
  }
  if (values.size !== 2) return null;
  const name = values.get('name') ?? '';
  const description = values.get('description') ?? '';
  if (
    !SKILL_NAME_RE.test(name)
    || description.length === 0
    || description.length > MAX_DESCRIPTION_CHARS
    || /[\r\n\0]/.test(name + description)
  ) return null;
  return { name, description };
}

function sectionEvidence(source: string): ExternalSkillAuditEntry['sections'] {
  interface MarkdownToken {
    type: string;
    depth?: number;
    text?: string;
    tokens?: MarkdownToken[];
    items?: MarkdownToken[];
    header?: Array<{ tokens?: MarkdownToken[] }>;
    rows?: Array<Array<{ tokens?: MarkdownToken[] }>>;
  }

  const visibleSequence = (tokens: readonly MarkdownToken[]): string => {
    if (tokens.some((token) => token.type === 'html')) return '';
    return tokens.map(visibleText).join(' ');
  };

  const containsRawHtml = (token: MarkdownToken): boolean => {
    if (token.type === 'html') return true;
    const nested = [
      ...(token.tokens ?? []),
      ...(token.items ?? []),
      ...(token.header ?? []).flatMap((cell) => cell.tokens ?? []),
      ...(token.rows ?? []).flatMap((row) => row.flatMap((cell) => cell.tokens ?? [])),
    ];
    return nested.some(containsRawHtml);
  };

  const visibleText = (token: MarkdownToken): string => {
    if (['html', 'def', 'space', 'hr', 'br', 'image'].includes(token.type)) return '';
    if (token.type === 'code' || token.type === 'codespan' || token.type === 'escape') {
      return token.text ?? '';
    }
    const nested = [
      ...(token.tokens ?? []),
      ...(token.items ?? []),
      ...(token.header ?? []).flatMap((cell) => cell.tokens ?? []),
      ...(token.rows ?? []).flatMap((row) => row.flatMap((cell) => cell.tokens ?? [])),
    ];
    if (nested.length > 0) return visibleSequence(nested);
    return token.type === 'text'
      ? (token.text ?? '').replace(/&(?:#[0-9]+|#x[a-f0-9]+|[a-z][a-z0-9]+);/gi, ' ')
      : '';
  };

  const sections: Array<{ heading: string; substantive: boolean; rawHtml: boolean }> = [];
  let current: { heading: string; substantive: boolean; rawHtml: boolean } | null = null;
  let tokens: MarkdownToken[];
  try {
    const markdownBody = source.replace(
      /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/,
      '',
    );
    tokens = Lexer.lex(markdownBody) as MarkdownToken[];
  } catch {
    tokens = [];
  }
  const documentHasRawHtml = tokens.some(containsRawHtml);
  for (const token of tokens) {
    if (token.type === 'heading') {
      if (token.depth === 2) {
        current = {
          heading: visibleText(token).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
          substantive: false,
          rawHtml: false,
        };
        sections.push(current);
      } else if ((token.depth ?? 0) < 2) current = null;
      continue;
    }
    if (current && token.type === 'html') {
      current.rawHtml = true;
      continue;
    }
    if (current && /[\p{L}\p{N}]/u.test(visibleText(token))) current.substantive = true;
  }

  const has = (...patterns: RegExp[]) => sections.some((section) => (
    section.substantive
    && !documentHasRawHtml
    && !section.rawHtml
    && patterns.some((pattern) => pattern.test(section.heading))
  ));
  return {
    whenToUse: has(/^when to use$/, /^use cases?$/),
    process: has(/process/, /workflow/, /^steps?$/, /^how it works$/, /implementation/),
    rationalizations: has(/rationalization/, /common excuses?/),
    redFlags: has(/red flags?/, /anti patterns?/, /failure modes?/),
    verification: has(/verification/, /exit criteria/, /definition of done/),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizePromptKey(value: string): string {
  const frequency = termFrequency(tokenize(value.normalize('NFKC')));
  const counts = [...frequency.values()];
  if (counts.length === 0) return '';
  const gcd = (left: number, right: number): number => {
    let a = left;
    let b = right;
    while (b !== 0) [a, b] = [b, a % b];
    return a;
  };
  const divisor = counts.reduce(gcd);
  return [...frequency.entries()]
    .sort(([left], [right]) => asciiCompare(left, right))
    .map(([term, count]) => `${term}:${count / divisor}`)
    .join('|');
}

function validCaseText(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= MAX_CASE_TEXT_CHARS
    && (allowEmpty || value.trim() !== '')
    && !/\p{C}/u.test(value)
    && /[\p{L}\p{N}\p{P}\p{S}]/u.test(value)
    && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
}

function normalizeFixtureRef(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.normalize('NFKC')) return null;
  if (isAbsolute(value) || value.includes('\\')) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function snapshotTreeContainsSymlink(candidate: string, state: AuditState): boolean {
  for (const [path, kind] of state.snapshotPathKinds) {
    if (kind === 'symlink' && inside(candidate, path)) return true;
  }
  return false;
}

function scanJsonString(raw: string, cursor: { index: number }): string {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < raw.length) {
    const char = raw[cursor.index]!;
    if (char === '\\') {
      cursor.index += 2;
      continue;
    }
    cursor.index += 1;
    if (char === '"') return JSON.parse(raw.slice(start, cursor.index)) as string;
  }
  throw new SyntaxError('unterminated JSON string');
}

/** Reject duplicate members before JSON.parse can collapse them last-key-wins. */
function jsonHasDuplicateObjectKeys(raw: string): boolean {
  const cursor = { index: 0 };
  let duplicate = false;
  const skipWhitespace = (): void => {
    while (/\s/u.test(raw[cursor.index] ?? '')) cursor.index += 1;
  };
  const scanValue = (): void => {
    skipWhitespace();
    const char = raw[cursor.index];
    if (char === '"') {
      scanJsonString(raw, cursor);
      return;
    }
    if (char === '{') {
      cursor.index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[cursor.index] === '}') {
        cursor.index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        if (raw[cursor.index] !== '"') throw new SyntaxError('JSON object key expected');
        const key = scanJsonString(raw, cursor);
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        skipWhitespace();
        if (raw[cursor.index] !== ':') throw new SyntaxError('JSON object colon expected');
        cursor.index += 1;
        scanValue();
        skipWhitespace();
        if (raw[cursor.index] === '}') {
          cursor.index += 1;
          return;
        }
        if (raw[cursor.index] !== ',') throw new SyntaxError('JSON object separator expected');
        cursor.index += 1;
      }
    }
    if (char === '[') {
      cursor.index += 1;
      skipWhitespace();
      if (raw[cursor.index] === ']') {
        cursor.index += 1;
        return;
      }
      for (;;) {
        scanValue();
        skipWhitespace();
        if (raw[cursor.index] === ']') {
          cursor.index += 1;
          return;
        }
        if (raw[cursor.index] !== ',') throw new SyntaxError('JSON array separator expected');
        cursor.index += 1;
      }
    }
    const start = cursor.index;
    while (cursor.index < raw.length && !/[\s,}\]]/u.test(raw[cursor.index]!)) cursor.index += 1;
    if (cursor.index === start) throw new SyntaxError('JSON value expected');
  };
  scanValue();
  skipWhitespace();
  if (cursor.index !== raw.length) throw new SyntaxError('unexpected JSON transport bytes');
  return duplicate;
}

function loadCases(path: string, skill: string, root: string, state: AuditState): LoadedCases {
  let source: string;
  try {
    const bytes = state.snapshotFiles.get(path);
    if (!bytes) throw new Error('eval-file-not-in-snapshot');
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    issue(state, 'error', 'invalid-eval-file', skill);
    return {
      positive: [], negative: [], behavioral: 0, behavioralValid: false, valid: false,
    };
  }
  let parsed: unknown;
  try {
    if (jsonHasDuplicateObjectKeys(source)) throw new SyntaxError('duplicate JSON object key');
    parsed = JSON.parse(source);
  } catch {
    issue(state, 'error', 'invalid-eval-file', skill);
    return { positive: [], negative: [], behavioral: 0, behavioralValid: false, valid: false };
  }
  const record = asObject(parsed);
  const trigger = asObject(record?.['trigger']);
  const positiveRaw = trigger?.['positive'];
  const negativeRaw = trigger?.['negative'];
  const evalsRaw = record?.['evals'];
  let valid = record?.['skill_name'] === skill
    && Array.isArray(positiveRaw)
    && Array.isArray(negativeRaw)
    && Array.isArray(evalsRaw)
    && positiveRaw.length <= MAX_TRIGGER_CASES
    && negativeRaw.length <= MAX_TRIGGER_CASES
    && evalsRaw.length <= MAX_BEHAVIORAL_CASES;
  let behavioralValid = Array.isArray(evalsRaw) && evalsRaw.length <= MAX_BEHAVIORAL_CASES;

  const positive: TriggerPositive[] = [];
  const triggerPrompts = new Set<string>();
  if (Array.isArray(positiveRaw)) {
    for (const raw of positiveRaw.slice(0, MAX_TRIGGER_CASES)) {
      const row = asObject(raw);
      const topK = row?.['top_k'] === undefined ? 3 : row['top_k'];
      if (
        !validCaseText(row?.['prompt'])
        || !Number.isSafeInteger(topK)
        || (topK as number) < 1
        || (topK as number) > MAX_TOP_K
      ) {
        valid = false;
        continue;
      }
      const promptKey = normalizePromptKey(row['prompt']);
      if (promptKey === '' || triggerPrompts.has(promptKey)) {
        valid = false;
        continue;
      }
      triggerPrompts.add(promptKey);
      positive.push({ prompt: row['prompt'], topK: topK as number });
    }
  }

  const negative: TriggerNegative[] = [];
  if (Array.isArray(negativeRaw)) {
    for (const raw of negativeRaw.slice(0, MAX_TRIGGER_CASES)) {
      const row = asObject(raw);
      if (
        !validCaseText(row?.['prompt'])
      ) {
        valid = false;
        continue;
      }
      const owner = row['owner'];
      if (owner !== undefined && (typeof owner !== 'string' || !SKILL_NAME_RE.test(owner))) {
        valid = false;
        continue;
      }
      const promptKey = normalizePromptKey(row['prompt']);
      if (promptKey === '' || triggerPrompts.has(promptKey)) {
        valid = false;
        continue;
      }
      triggerPrompts.add(promptKey);
      negative.push({ prompt: row['prompt'], ...(typeof owner === 'string' ? { owner } : {}) });
    }
  }

  let behavioral = 0;
  const behavioralIds = new Set<number>();
  if (Array.isArray(evalsRaw)) {
    for (const raw of evalsRaw.slice(0, MAX_BEHAVIORAL_CASES)) {
      const row = asObject(raw);
      const kind = row?.['kind'] ?? 'execution';
      const id = row?.['id'];
      const files = row?.['files'];
      const expectations = row?.['expectations'];
      const normalizedFiles = Array.isArray(files)
        ? files.map(normalizeFixtureRef)
        : [];
      const fixtureEntriesValid = kind === 'dialogue'
        ? files === undefined
        : (
        Array.isArray(files)
        && files.length > 0
        && files.length <= MAX_FIXTURE_REFS
        && normalizedFiles.every((entry): entry is string => entry !== null)
        && new Set(normalizedFiles).size === normalizedFiles.length
        && normalizedFiles.every((entry) => {
          try {
            const fixturesRoot = join(root, 'evals', 'fixtures');
            const candidate = resolve(fixturesRoot, entry);
            if (!inside(fixturesRoot, candidate)) return false;
            const digest = state.snapshotTreeDigests.get(candidate);
            if (!digest || snapshotTreeContainsSymlink(candidate, state)) return false;
            return true;
          } catch {
            return false;
          }
        })
        );
      const shapeOk = Number.isSafeInteger(id)
        && (id as number) > 0
        && validCaseText(row?.['prompt'])
        && validCaseText(row?.['expected_output'])
        && Array.isArray(expectations)
        && expectations.length > 0
        && expectations.length <= MAX_EXPECTATIONS
        && expectations.every((entry) => (
          validCaseText(entry)
        ))
        && (kind === 'execution' || kind === 'dialogue')
        && fixtureEntriesValid;
      if (shapeOk && !behavioralIds.has(id as number)) {
        behavioralIds.add(id as number);
        behavioral += 1;
      } else {
        valid = false;
        behavioralValid = false;
      }
    }
  }

  if (positive.length < MIN_POSITIVE_TRIGGERS) valid = false;
  if (negative.length < MIN_NEGATIVE_TRIGGERS) valid = false;
  if (behavioral < MIN_BEHAVIORAL_EVALS) {
    valid = false;
    behavioralValid = false;
  }
  if (!valid) issue(state, 'error', 'incomplete-eval-contract', skill);
  return {
    positive,
    negative,
    behavioral,
    behavioralValid,
    valid,
  };
}

function stem(token: string): string {
  /*
   * The deterministic trigger-ranking pipeline is adapted from
   * addyosmani/agent-skills scripts/run-evals.js at commit fefc4075.
   *
   * MIT License
   * Copyright (c) 2025 Addy Osmani
   *
   * Permission is hereby granted, free of charge, to any person obtaining a
   * copy of this software and associated documentation files (the "Software"),
   * to deal in the Software without restriction, including without limitation
   * the rights to use, copy, modify, merge, publish, distribute, sublicense,
   * and/or sell copies of the Software, and to permit persons to whom the
   * Software is furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in
   * all copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
   * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
   * IN THE SOFTWARE.
   */
  let value = token;
  for (const suffix of ['ally', 'ing', 'ed', 'es', 'al']) {
    if (value.length > suffix.length + 3 && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) value = value.slice(0, -1);
  if (value.length > 4 && value.endsWith('e')) value = value.slice(0, -1);
  if (
    value.length > 4
    && value.at(-1) === value.at(-2)
    && !'aeiou'.includes(value.at(-1) ?? '')
  ) value = value.slice(0, -1);
  if (value.length > 3 && value.endsWith('y')) value = `${value.slice(0, -1)}i`;
  return value;
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .map(stem);
}

function termFrequency(tokens: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
  return result;
}

function cosine(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [term, weight] of left) {
    leftNorm += weight * weight;
    dot += weight * (right.get(term) ?? 0);
  }
  for (const weight of right.values()) rightNorm += weight * weight;
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

function vectors(skills: readonly LoadedSkill[]): Map<string, Map<string, number>> {
  const frequencies = new Map<string, Map<string, number>>();
  const documentFrequency = new Map<string, number>();
  for (const skill of skills) {
    const nameTokens = tokenize(skill.name.replace(/-/g, ' '));
    const frequency = termFrequency([...nameTokens, ...nameTokens, ...tokenize(skill.description)]);
    frequencies.set(skill.name, frequency);
    for (const term of frequency.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const result = new Map<string, Map<string, number>>();
  for (const [name, frequency] of frequencies) {
    const vector = new Map<string, number>();
    for (const [term, count] of frequency) {
      const idf = Math.log(1 + skills.length / (1 + (documentFrequency.get(term) ?? 0)));
      vector.set(term, count * idf);
    }
    result.set(name, vector);
  }
  return result;
}

function documentFrequencies(
  skillVectors: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const vector of skillVectors.values()) {
    for (const term of vector.keys()) result.set(term, (result.get(term) ?? 0) + 1);
  }
  return result;
}

function promptVectorFromCorpus(
  prompt: string,
  skillCount: number,
  documentFrequency: ReadonlyMap<string, number>,
): Map<string, number> {
  const frequency = termFrequency(tokenize(prompt));
  const result = new Map<string, number>();
  for (const [term, count] of frequency) {
    const idf = Math.log(1 + skillCount / (1 + (documentFrequency.get(term) ?? 0)));
    result.set(term, count * idf);
  }
  return result;
}

interface RankedSkill {
  name: string;
  score: number;
}

interface SkillRoutingOutcome {
  passed: boolean;
  topKPassed: number;
  rankOnePassed: number;
  rankOneRate: number | null;
  negativePassed: number;
}

function rank(
  prompt: string,
  skills: readonly LoadedSkill[],
  skillVectors: ReadonlyMap<string, Map<string, number>>,
  documentFrequency: ReadonlyMap<string, number>,
): RankedSkill[] {
  const promptValues = promptVectorFromCorpus(prompt, skills.length, documentFrequency);
  return skills.map((skill) => ({
    name: skill.name,
    score: cosine(promptValues, skillVectors.get(skill.name) ?? new Map()),
  })).sort((left, right) => right.score - left.score || asciiCompare(left.name, right.name))
    .map((entry) => ({
      name: entry.name,
      score: Math.round(entry.score * 1_000_000) / 1_000_000,
    }));
}

function missingReport(code: ExternalSkillAuditIssueCode): ExternalSkillAuditReport {
  return {
    schemaVersion: 1,
    mode: 'quarantine',
    packDigest: null,
    skillCount: 0,
    caseFileCount: 0,
    bytesRead: 0,
    structural: { passed: false, errors: 1, warnings: 0 },
    routing: {
      passed: false,
      positivePrompts: 0,
      topKPassed: 0,
      rankOnePassed: 0,
      rankOneRate: null,
      negativePrompts: 0,
      negativePassed: 0,
      collisionErrors: 0,
      collisionWarnings: 0,
      thresholds: {
        minimumRankOneRate: MIN_RANK_ONE_RATE,
        collisionWarning: COLLISION_WARNING,
        collisionError: COLLISION_ERROR,
      },
    },
    behavioral: { state: 'missing', declaredCases: 0 },
    trialReady: false,
    promotion: {
      eligible: false,
      blockers: [
        'external-content-quarantined',
        'source-provenance-required',
        'immutable-source-snapshot-required',
        'license-review-required',
        'behavioral-evidence-required',
        'verified-outcome-required',
      ],
    },
    issues: [{ level: 'error', code }],
    collisions: [],
    skills: [],
  };
}

/** Audit a local external skill pack without executing or persisting its content. */
export function auditExternalSkillPack(packPath: string): ExternalSkillAuditReport {
  const state: AuditState = {
    bytesRead: 0,
    issues: [],
    fileCache: new Map(),
    treeDigests: new Map(),
    snapshotFiles: new Map(),
    snapshotTreeDigests: new Map(),
    snapshotDirectoryEntries: new Map(),
    snapshotPathKinds: new Map(),
    fixtureEntriesObserved: 0,
  };
  let root: string;
  let skillsRoot: string;
  let packDigest: string;
  try {
    const requestedRoot = resolve(packPath);
    const requestedRootStat = lstatSync(requestedRoot);
    if (!requestedRootStat.isDirectory() || requestedRootStat.isSymbolicLink()) {
      return missingReport('invalid-pack-root');
    }
    root = realpathSync(requestedRoot);
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return missingReport('invalid-pack-root');
    skillsRoot = join(root, 'skills');
    const skillsStat = lstatSync(skillsRoot);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return missingReport('invalid-skills-directory');
    if (!inside(root, realpathSync(skillsRoot))) return missingReport('skills-directory-escapes-pack');
    packDigest = digestTreePath(root, root, root, state, 0, true);
  } catch {
    return missingReport('pack-unavailable-or-unsafe');
  }

  const entryNames = state.snapshotDirectoryEntries.get(skillsRoot);
  if (!entryNames) {
    return missingReport('skills-directory-unreadable');
  }
  if (entryNames.length > MAX_DIRECTORY_ENTRIES) return missingReport('skill-directory-entry-limit');

  const skills: LoadedSkill[] = [];
  for (const entryName of [...entryNames].sort(asciiCompare)) {
    if (skills.length >= MAX_SKILLS) {
      issue(state, 'error', 'skill-count-limit');
      break;
    }
    const skillDir = join(skillsRoot, entryName);
    if (state.snapshotPathKinds.get(skillDir) !== 'directory' || !SKILL_NAME_RE.test(entryName)) {
      issue(state, 'error', 'invalid-skill-directory');
      continue;
    }
    const file = join(skillDir, 'SKILL.md');
    let source: string;
    try {
      const bytes = state.snapshotFiles.get(file);
      if (!bytes) throw new Error('skill-file-not-in-snapshot');
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      issue(state, 'error', 'skill-file-unreadable', entryName);
      continue;
    }
    const frontmatter = parseFrontmatter(source);
    if (!frontmatter || frontmatter.name !== entryName) {
      issue(state, 'error', 'invalid-skill-frontmatter', entryName);
      continue;
    }
    const sections = sectionEvidence(source);
    if (!sections.whenToUse || !sections.process || !sections.verification) {
      issue(state, 'error', 'incomplete-workflow-sections', entryName);
    }
    if (!sections.rationalizations || !sections.redFlags) {
      issue(state, 'warning', 'missing-adversarial-sections', entryName);
    }
    skills.push({
      name: frontmatter.name,
      description: frontmatter.description,
      contentHash: sha256(source),
      descriptionHash: sha256(frontmatter.description),
      bytes: Buffer.byteLength(source, 'utf8'),
      sections,
    });
  }

  if (skills.length === 0) issue(state, 'error', 'no-valid-skills');
  const skillNames = new Set(skills.map((skill) => skill.name));
  const cases = new Map<string, LoadedCases>();
  let caseFileCount = 0;
  try {
    const casesRoot = join(root, 'evals', 'cases');
    const caseEntries = state.snapshotDirectoryEntries.get(casesRoot);
    if (!caseEntries) throw new Error('eval-cases-directory-unavailable');
    if (caseEntries.length > MAX_DIRECTORY_ENTRIES) throw new Error('eval-case-entry-limit');
    for (const entryName of caseEntries) {
      const entryPath = join(casesRoot, entryName);
      if (state.snapshotPathKinds.get(entryPath) !== 'file' || !entryName.endsWith('.json')) {
        issue(state, 'error', 'unexpected-eval-entry');
        continue;
      }
      caseFileCount += 1;
      const caseSkill = entryName.slice(0, -'.json'.length);
      if (!SKILL_NAME_RE.test(caseSkill)) {
        issue(state, 'error', 'invalid-eval-case-name');
        continue;
      }
      if (!skillNames.has(caseSkill)) issue(state, 'error', 'orphan-eval-file', caseSkill);
    }
  } catch {
    issue(state, 'error', 'eval-cases-directory-unavailable');
  }
  for (const skill of skills) {
    const path = join(root, 'evals', 'cases', `${skill.name}.json`);
    try {
      cases.set(skill.name, loadCases(path, skill.name, root, state));
    } catch {
      issue(state, 'error', 'missing-eval-file', skill.name);
      cases.set(skill.name, {
        positive: [], negative: [], behavioral: 0, behavioralValid: false, valid: false,
      });
    }
  }

  for (const [skill, contract] of cases) {
    for (const negative of contract.negative) {
      if (negative.owner && !skillNames.has(negative.owner)) {
        issue(state, 'error', 'unknown-negative-owner', skill);
        contract.valid = false;
      }
    }
  }

  const triggerOwners = new Map<string, Set<string>>();
  for (const [skill, contract] of cases) {
    for (const trigger of [...contract.positive, ...contract.negative]) {
      const key = normalizePromptKey(trigger.prompt);
      const owners = triggerOwners.get(key) ?? new Set<string>();
      owners.add(skill);
      triggerOwners.set(key, owners);
    }
  }
  for (const owners of triggerOwners.values()) {
    if (owners.size < 2) continue;
    for (const skill of owners) {
      const contract = cases.get(skill);
      if (contract) contract.valid = false;
      issue(state, 'error', 'duplicate-cross-skill-trigger', skill);
    }
  }

  const skillVectors = vectors(skills);
  const documentFrequency = documentFrequencies(skillVectors);
  let positivePrompts = 0;
  let topKPassed = 0;
  let rankOnePassed = 0;
  let negativePrompts = 0;
  let negativePassed = 0;
  let declaredCases = 0;
  const skillRouting = new Map<string, SkillRoutingOutcome>();
  for (const [skill, contract] of cases) {
    let skillTopKPassed = 0;
    let skillRankOnePassed = 0;
    let skillNegativePassed = 0;
    declaredCases += contract.behavioral;
    for (const positive of contract.positive) {
      const ranked = rank(positive.prompt, skills, skillVectors, documentFrequency);
      const candidate = ranked.find((entry) => entry.name === skill);
      positivePrompts += 1;
      const strongerOrTiedCompetitors = ranked.filter((entry) => (
        entry.name !== skill && entry.score >= (candidate?.score ?? 0)
      )).length;
      if (
        (candidate?.score ?? 0) > 0
        && strongerOrTiedCompetitors < positive.topK
      ) {
        topKPassed += 1;
        skillTopKPassed += 1;
      }
      if (
        (candidate?.score ?? 0) > 0
        && ranked.every((entry) => entry.name === skill || entry.score < (candidate?.score ?? 0))
      ) {
        rankOnePassed += 1;
        skillRankOnePassed += 1;
      }
    }
    for (const negative of contract.negative) {
      const ranked = rank(negative.prompt, skills, skillVectors, documentFrequency);
      negativePrompts += 1;
      const candidate = ranked.find((entry) => entry.name === skill);
      const owner = negative.owner
        ? ranked.find((entry) => entry.name === negative.owner)
        : undefined;
      const passed = owner
        ? owner.score > (candidate?.score ?? 0)
        : ranked.some((entry) => entry.name !== skill && entry.score > (candidate?.score ?? 0));
      if (passed) {
        negativePassed += 1;
        skillNegativePassed += 1;
      }
    }
    const skillRankOneRate = contract.positive.length > 0
      ? skillRankOnePassed / contract.positive.length
      : null;
    skillRouting.set(skill, {
      passed: contract.valid
        && contract.positive.length > 0
        && skillTopKPassed === contract.positive.length
        && skillNegativePassed === contract.negative.length
        && skillRankOneRate !== null
        && skillRankOneRate >= MIN_RANK_ONE_RATE,
      topKPassed: skillTopKPassed,
      rankOnePassed: skillRankOnePassed,
      rankOneRate: skillRankOneRate,
      negativePassed: skillNegativePassed,
    });
  }

  const collisions: ExternalSkillCollision[] = [];
  for (let leftIndex = 0; leftIndex < skills.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex += 1) {
      const left = skills[leftIndex]!;
      const right = skills[rightIndex]!;
      const similarity = Math.round(cosine(
        skillVectors.get(left.name) ?? new Map(),
        skillVectors.get(right.name) ?? new Map(),
      ) * 1_000_000) / 1_000_000;
      if (similarity < COLLISION_WARNING) continue;
      collisions.push({
        left: left.name,
        right: right.name,
        similarity,
        level: similarity >= COLLISION_ERROR ? 'error' : 'warning',
      });
    }
  }

  const rankOneRate = positivePrompts > 0 ? rankOnePassed / positivePrompts : null;
  const collisionErrors = collisions.filter((collision) => collision.level === 'error').length;
  const collisionWarnings = collisions.length - collisionErrors;
  const structuralErrors = state.issues.filter((entry) => entry.level === 'error').length;
  const structuralWarnings = state.issues.length - structuralErrors;
  const structuralPassed = structuralErrors === 0;
  const routingPassed = structuralPassed
    && positivePrompts > 0
    && topKPassed === positivePrompts
    && negativePassed === negativePrompts
    && rankOneRate !== null
    && rankOneRate >= MIN_RANK_ONE_RATE
    && [...skillRouting.values()].every((outcome) => outcome.passed)
    && collisionErrors === 0;
  const behavioralState: ExternalSkillAuditReport['behavioral']['state'] = skills.length === 0
    ? 'missing'
    : [...cases.values()].some((contract) => !contract.behavioralValid)
      ? 'invalid'
      : declaredCases > 0
        ? 'declared'
        : 'missing';
  const trialReady = structuralPassed && routingPassed && behavioralState === 'declared';

  return {
    schemaVersion: 1,
    mode: 'quarantine',
    packDigest,
    skillCount: skills.length,
    caseFileCount,
    bytesRead: state.bytesRead,
    structural: { passed: structuralPassed, errors: structuralErrors, warnings: structuralWarnings },
    routing: {
      passed: routingPassed,
      positivePrompts,
      topKPassed,
      rankOnePassed,
      rankOneRate: rankOneRate === null ? null : Math.round(rankOneRate * 1_000_000) / 1_000_000,
      negativePrompts,
      negativePassed,
      collisionErrors,
      collisionWarnings,
      thresholds: {
        minimumRankOneRate: MIN_RANK_ONE_RATE,
        collisionWarning: COLLISION_WARNING,
        collisionError: COLLISION_ERROR,
      },
    },
    behavioral: { state: behavioralState, declaredCases },
    trialReady,
    promotion: {
      eligible: false,
      blockers: [
        'external-content-quarantined',
        'source-provenance-required',
        'immutable-source-snapshot-required',
        'license-review-required',
        'behavioral-evidence-required',
        'verified-outcome-required',
      ],
    },
    issues: state.issues.sort((left, right) => (
      asciiCompare(left.skill ?? '', right.skill ?? '') || asciiCompare(left.code, right.code)
    )),
    collisions: collisions.sort((left, right) => (
      right.similarity - left.similarity
      || asciiCompare(left.left, right.left)
      || asciiCompare(left.right, right.right)
    )),
    skills: skills.map((skill) => ({
      name: skill.name,
      contentHash: skill.contentHash,
      descriptionHash: skill.descriptionHash,
      bytes: skill.bytes,
      sections: skill.sections,
      triggerCases: {
        positive: cases.get(skill.name)?.positive.length ?? 0,
        negative: cases.get(skill.name)?.negative.length ?? 0,
        behavioral: cases.get(skill.name)?.behavioral ?? 0,
      },
      routing: {
        passed: skillRouting.get(skill.name)?.passed ?? false,
        topKPassed: skillRouting.get(skill.name)?.topKPassed ?? 0,
        rankOnePassed: skillRouting.get(skill.name)?.rankOnePassed ?? 0,
        rankOneRate: roundedRate(skillRouting.get(skill.name)?.rankOneRate),
        negativePassed: skillRouting.get(skill.name)?.negativePassed ?? 0,
      },
    })),
  };
}

/** Bounded failure report for the killable CLI audit process. */
export function failedExternalSkillAudit(
  code: 'audit-worker-timeout' | 'audit-worker-failed',
): ExternalSkillAuditReport {
  return missingReport(code);
}

/** Stable human-readable summary. Does not echo untrusted skill text. */
export function formatExternalSkillAudit(report: ExternalSkillAuditReport): string {
  const rate = report.routing.rankOneRate === null
    ? 'unavailable'
    : `${Math.round(report.routing.rankOneRate * 1000) / 10}%`;
  const lines = [
    `External skill pack: ${report.trialReady ? 'trial-ready' : 'blocked'}`,
    `Mode: ${report.mode} (never active)`,
    `Digest: ${report.packDigest ?? 'unavailable'}`,
    `Skills: ${report.skillCount}; eval files: ${report.caseFileCount}; bytes read: ${report.bytesRead}`,
    `Structural: ${report.structural.passed ? 'pass' : 'fail'} (${report.structural.errors} errors, ${report.structural.warnings} warnings)`,
    `Routing: ${report.routing.passed ? 'pass' : 'fail'} (rank-1 ${rate}; top-k ${report.routing.topKPassed}/${report.routing.positivePrompts}; negatives ${report.routing.negativePassed}/${report.routing.negativePrompts})`,
    `Collisions: ${report.routing.collisionErrors} errors, ${report.routing.collisionWarnings} warnings`,
    `Behavioral fixtures: ${report.behavioral.state} (${report.behavioral.declaredCases})`,
    `Promotion: blocked (${report.promotion.blockers.join(', ')})`,
  ];
  const failedSkills = report.skills.filter((skill) => !skill.routing.passed);
  if (failedSkills.length > 0) {
    lines.push(`Per-skill routing: ${report.skills.length - failedSkills.length}/${report.skills.length} passed`);
    lines.push(`Failed skills: ${failedSkills.slice(0, 20).map((skill) => skill.name).join(', ')}`);
    if (failedSkills.length > 20) lines.push(`  ... ${failedSkills.length - 20} more`);
  }
  if (report.issues.length > 0) {
    lines.push('Issues:');
    for (const entry of report.issues.slice(0, 20)) {
      lines.push(`  ${entry.level}: ${entry.code}${entry.skill ? ` [${entry.skill}]` : ''}`);
    }
    if (report.issues.length > 20) lines.push(`  ... ${report.issues.length - 20} more`);
  }
  return lines.join('\n');
}
