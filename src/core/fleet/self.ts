/**
 * M54: safety controls for changes authored against ashlr-hub itself.
 *
 * Test infrastructure is immutable to judge-free automation. Differential
 * runtime evidence may eventually permit safe additions, but path authority is
 * intentionally fail-closed until that proof exists.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AshlrConfig, Proposal } from '../types.js';

const SELF_PACKAGE_NAME = '@ashlr/hub';

/** Detect an ashlr-hub checkout with a bounded package.json read. */
export function isSelfTargetProposal(proposal: Proposal, _cfg?: AshlrConfig): boolean {
  const repo = proposal.repo;
  if (!repo) return false;
  try {
    const pkgPath = join(repo, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const raw = readFileSync(pkgPath, 'utf8');
    if (raw.length > 256 * 1024) return false;
    return (JSON.parse(raw) as { name?: unknown }).name === SELF_PACKAGE_NAME;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The test-infrastructure guard
// ---------------------------------------------------------------------------

const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_FILES = 10_000;
const MAX_DIFF_LINES = 100_000;
const MAX_GIT_PATH_BYTES = 4 * 1024;
const MAX_HEADER_SPLIT_CANDIDATES = 64;
const TEST_DIRECTORY_NAMES = new Set(['test', 'tests', '__tests__']);
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_CONFIG_RE = /^(?:vitest|jest)\.(?:config|workspace|projects?)\.[cm]?[jt]sx?$/i;
const TEST_SCRIPT_RE = /^scripts\/test(?:[-_.]|$)/i;

export function isSafetyTestFile(path: string): boolean {
  const segments = path.split('/');
  const basename = segments[segments.length - 1] ?? '';
  return (
    segments.some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase())) ||
    TEST_FILE_RE.test(basename) ||
    TEST_CONFIG_RE.test(basename) ||
    TEST_SCRIPT_RE.test(path)
  );
}

export interface SafetyGuardVerdict {
  weakened: boolean;
  reason: string;
  files: string[];
}

interface GitHeaderPaths {
  oldPath: string;
  newPath: string;
}

const GIT_ESCAPES: Readonly<Record<string, number>> = {
  a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92,
};

function parseQuotedGitPath(input: string): string {
  const bytes: number[] = [];
  let index = 1;
  while (index < input.length - 1) {
    const char = input[index]!;
    if (char === '"') throw new Error('unescaped quote in Git path');
    if (char !== '\\') {
      const literal = String.fromCodePoint(input.codePointAt(index)!);
      bytes.push(...Buffer.from(literal));
      index += literal.length;
      continue;
    }
    index++;
    const escaped = input[index++];
    if (escaped === undefined) throw new Error('unterminated Git path escape');
    const simple = GIT_ESCAPES[escaped];
    if (simple !== undefined) bytes.push(simple);
    else if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (index < input.length - 1 && octal.length < 3 && /[0-7]/.test(input[index]!)) {
        octal += input[index++]!;
      }
      const value = Number.parseInt(octal, 8);
      if (value > 255) throw new Error('invalid Git path escape');
      bytes.push(value);
    } else throw new Error('invalid Git path escape');
    if (bytes.length > MAX_GIT_PATH_BYTES) throw new Error('Git path exceeds limit');
  }
  const path = Buffer.from(bytes).toString('utf8');
  if (path.includes('\ufffd')) throw new Error('invalid UTF-8 Git path');
  return path;
}

function parseGitPath(input: string): string {
  let path: string;
  if (input.startsWith('"')) {
    if (!input.endsWith('"') || input.length < 2) throw new Error('invalid quoted Git path');
    path = parseQuotedGitPath(input);
  } else {
    if (!input || /[\\"\r\n]/.test(input)) throw new Error('invalid Git path');
    path = input;
  }
  if (Buffer.byteLength(path) > MAX_GIT_PATH_BYTES) throw new Error('Git path exceeds limit');
  return path;
}

function canonicalRepoPath(path: string): string {
  const segments = path.split('/');
  if (
    !path ||
    path.startsWith('/') ||
    Array.from(path).some((char) => {
      const code = char.codePointAt(0)!;
      return code <= 31 || code === 127;
    }) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('noncanonical repository path');
  }
  return path;
}

function prefixedPath(input: string, prefix: 'a' | 'b'): string {
  const path = parseGitPath(input);
  if (!path.startsWith(`${prefix}/`)) throw new Error('noncanonical diff prefix');
  return canonicalRepoPath(path.slice(2));
}

function parseDiffHeader(line: string): GitHeaderPaths[] {
  if (!line.startsWith('diff --git ')) throw new Error('invalid diff header');
  const body = line.slice(11);
  if (Buffer.byteLength(body) > MAX_GIT_PATH_BYTES * 2 + 8) throw new Error('header too long');
  const candidates: GitHeaderPaths[] = [];
  for (let split = 0; split < body.length; split++) {
    if (body[split] !== ' ') continue;
    const right = body.slice(split + 1);
    if (!right.startsWith('b/') && !right.startsWith('"b/')) continue;
    try {
      const candidate = {
        oldPath: prefixedPath(body.slice(0, split), 'a'),
        newPath: prefixedPath(right, 'b'),
      };
      if (!candidates.some((item) => item.oldPath === candidate.oldPath && item.newPath === candidate.newPath)) {
        candidates.push(candidate);
      }
      if (candidates.length > MAX_HEADER_SPLIT_CANDIDATES) throw new Error('too many paths');
    } catch (error) {
      if (error instanceof Error && error.message === 'too many paths') throw error;
    }
  }
  if (candidates.length === 0) throw new Error('invalid diff paths');
  return candidates;
}

function metadataPath(input: string, prefix?: 'a' | 'b'): string {
  const raw = input.endsWith('\t') ? input.slice(0, -1) : input;
  return prefix ? prefixedPath(raw, prefix) : canonicalRepoPath(parseGitPath(raw));
}

interface FileDiff {
  candidates: GitHeaderPaths[];
  headerOldPath: string;
  headerNewPath: string;
  oldPath: string;
  newPath: string;
  oldIsDevNull: boolean;
  newIsDevNull: boolean;
  oldMarkerCount: number;
  newMarkerCount: number;
  inHunk: boolean;
}

function constrainPath(file: FileDiff, side: 'oldPath' | 'newPath', path: string): void {
  file.candidates = file.candidates.filter((candidate) => candidate[side] === path);
  if (file.candidates.length === 0) throw new Error('path metadata disagrees with header');
}

function resolvePaths(file: FileDiff): void {
  if (file.candidates.length !== 1) throw new Error('ambiguous diff paths');
  file.headerOldPath = file.candidates[0]!.oldPath;
  file.headerNewPath = file.candidates[0]!.newPath;
  file.oldPath = file.oldIsDevNull ? '' : file.headerOldPath;
  file.newPath = file.newIsDevNull ? '' : file.headerNewPath;
}

function assertDiffLineBound(diff: string): void {
  let lines = 1;
  for (let index = diff.indexOf('\n'); index !== -1; index = diff.indexOf('\n', index + 1)) {
    if (++lines > MAX_DIFF_LINES) throw new Error('diff line limit exceeded');
  }
}

function parseDiff(diff: string): FileDiff[] {
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) throw new Error('diff byte limit exceeded');
  assertDiffLineBound(diff);
  const lines = diff.split('\n');
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;

  const finish = (): void => {
    if (!file) return;
    resolvePaths(file);
    files.push(file);
    file = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith('diff --') && !line.startsWith('diff --git ')) throw new Error('unsupported diff');
    if (line.startsWith('diff --git')) {
      finish();
      if (files.length >= MAX_DIFF_FILES) throw new Error('diff file limit exceeded');
      file = {
        candidates: parseDiffHeader(line), headerOldPath: '', headerNewPath: '', oldPath: '', newPath: '',
        oldIsDevNull: false, newIsDevNull: false, oldMarkerCount: 0, newMarkerCount: 0,
        inHunk: false,
      };
      continue;
    }
    if (!file) continue;
    if (line.startsWith('@@')) {
      file.inHunk = true;
      continue;
    }
    if (!file.inHunk) {
      if (line === '--- /dev/null' || line === '--- /dev/null\t') {
        if (++file.oldMarkerCount !== 1) throw new Error('duplicate old path marker');
        file.oldIsDevNull = true;
      } else if (line === '+++ /dev/null' || line === '+++ /dev/null\t') {
        if (++file.newMarkerCount !== 1) throw new Error('duplicate new path marker');
        file.newIsDevNull = true;
      } else if (line.startsWith('--- ')) {
        if (++file.oldMarkerCount !== 1) throw new Error('duplicate old path marker');
        constrainPath(file, 'oldPath', metadataPath(line.slice(4), 'a'));
      } else if (line.startsWith('+++ ')) {
        if (++file.newMarkerCount !== 1) throw new Error('duplicate new path marker');
        constrainPath(file, 'newPath', metadataPath(line.slice(4), 'b'));
      } else if (line.startsWith('rename from ')) {
        constrainPath(file, 'oldPath', metadataPath(line.slice(12)));
      } else if (line.startsWith('rename to ')) {
        constrainPath(file, 'newPath', metadataPath(line.slice(10)));
      } else if (line.startsWith('copy from ')) {
        constrainPath(file, 'oldPath', metadataPath(line.slice(10)));
      } else if (line.startsWith('copy to ')) {
        constrainPath(file, 'newPath', metadataPath(line.slice(8)));
      }
    }
  }
  finish();
  if (files.length === 0) throw new Error('diff has no Git file headers');
  return files;
}

/** Any mutation of test infrastructure requires judge or human review. */
export function guardSafetyTests(diff: string): SafetyGuardVerdict {
  if (!diff || !diff.trim()) return { weakened: false, reason: 'empty diff', files: [] };
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
    return { weakened: true, reason: 'unparseable diff over self-target - refused', files: [] };
  }

  let files: FileDiff[];
  try {
    files = parseDiff(diff);
  } catch {
    return { weakened: true, reason: 'unparseable diff over self-target - refused', files: [] };
  }

  const touched: string[] = [];
  for (const file of files) {
    const path = [file.oldPath, file.newPath].find((candidate) => candidate && isSafetyTestFile(candidate));
    if (!path) continue;
    touched.push(path);
    return { weakened: true, reason: `diff touches protected test infrastructure '${path}' - refused`, files: touched };
  }
  return { weakened: false, reason: 'no protected test infrastructure touched', files: touched };
}

// ---------------------------------------------------------------------------
// Self-eval parity harness
// ---------------------------------------------------------------------------

export interface SelfEvalVerdict {
  ok: boolean;
  reason: string;
}

export function selfEvalParity(runSuite: (flagOn: boolean) => boolean): SelfEvalVerdict {
  let offGreen: boolean;
  let onGreen: boolean;
  try { offGreen = runSuite(false); } catch { offGreen = false; }
  if (!offGreen) return { ok: false, reason: 'invariant suite not green with foundry flag OFF' };
  try { onGreen = runSuite(true); } catch { onGreen = false; }
  if (!onGreen) return { ok: false, reason: 'invariant suite not green with foundry flag ON' };
  return { ok: true, reason: 'invariant suite green flag-off AND flag-on' };
}

export async function selfEvalParityAsync(
  runSuite: (flagOn: boolean) => boolean | Promise<boolean>,
): Promise<SelfEvalVerdict> {
  let offGreen: boolean;
  let onGreen: boolean;
  try { offGreen = await runSuite(false); } catch { offGreen = false; }
  if (!offGreen) return { ok: false, reason: 'invariant suite not green with foundry flag OFF' };
  try { onGreen = await runSuite(true); } catch { onGreen = false; }
  if (!onGreen) return { ok: false, reason: 'invariant suite not green with foundry flag ON' };
  return { ok: true, reason: 'invariant suite green flag-off AND flag-on' };
}
