/**
 * self.ts — M54 (v5 Open Fleet): the self-improving fleet's safety harness.
 *
 * The fleet may modify ashlr-hub's OWN source, but it may NEVER weaken its own
 * safety guarantees. Two pure mechanisms enforce that:
 *
 *   1. `guardSafetyTests(diff)` — the never-weaken guard. Refuses, BY CONSTRUCTION
 *      and BEFORE any verification runs, any diff that deletes a safety/invariant
 *      test file, removes assertions from one, or focuses/skips tests. This
 *      applies to ordinary tests in every enrolled repo, not only Ashlr-named
 *      invariant suites. Agents may add coverage, but cannot make the suite
 *      weaker and then use that weakened suite as judge-free evidence.
 *   2. `selfEvalParity(runSuite)` — the self-eval harness contract: a self-target
 *      change is only eligible when the invariant suite is green with the foundry
 *      flag OFF *and* ON. Higher-order + pure so it is unit-testable with a stub
 *      runner; the gated auto-merge pass supplies the real suite runner.
 *
 * Plus `isSelfTargetProposal` — detect when a proposal targets ashlr-hub itself
 * (by package name, not a brittle absolute path).
 *
 * All functions are PURE (except the bounded fs read in isSelfTargetProposal) and
 * NEVER throw.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AshlrConfig, Proposal } from '../types.js';

// ---------------------------------------------------------------------------
// Self-target detection
// ---------------------------------------------------------------------------

/** The package name that identifies ashlr-hub's own repo. */
const SELF_PACKAGE_NAME = '@ashlr/hub';

/**
 * True when `proposal` targets ashlr-hub's own source tree — detected by reading
 * the repo's package.json `name` (=== '@ashlr/hub'), never a hardcoded path.
 * Bounded read; never throws; false on any doubt.
 */
export function isSelfTargetProposal(proposal: Proposal, _cfg?: AshlrConfig): boolean {
  const repo = proposal.repo;
  if (!repo) return false;
  try {
    const pkgPath = join(repo, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const raw = readFileSync(pkgPath, 'utf8');
    if (raw.length > 256 * 1024) return false; // bounded
    const pkg = JSON.parse(raw) as { name?: unknown };
    return pkg.name === SELF_PACKAGE_NAME;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The never-weaken guard
// ---------------------------------------------------------------------------

/**
 * Patterns for test files whose weakening would disarm a safety invariant. A
 * diff that deletes one of these, or nets out assertions from one, is refused.
 */
const SAFETY_FILE_PATTERNS: readonly RegExp[] = [
  /^test\/h\d+[.-].*\.test\.ts$/, // h1..h8 hardening / invariant suites
  /^test\/m45\.foundry\.test\.ts$/, // sandboxed-engine containment
  /^test\/m47[._].*\.test\.ts$/, // merge gate + provenance
  /^test\/m51\.trust\.test\.ts$/, // tri-tier trust
  /^test\/m52\..*\.test\.ts$/, // OS confinement
  /^test\/m54\..*\.test\.ts$/, // the self-improvement guard itself
  /daemon-gates/, // daemon-no-primitive source grep-guard
  /proposal-only/,
  /\.safety\./,
];

const TEST_DIRECTORY_NAMES = new Set(['test', 'tests', '__tests__']);
const ORDINARY_TEST_FILE_PATTERNS: readonly RegExp[] = [
  /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|kts|cs|c|cc|cpp|cxx|go|rs|swift)$/i,
  /(?:^|\/)test_[^/]+\.py$/i,
  /(?:^|\/)[^/]+_test\.(?:py|go|rb|php)$/i,
  /(?:^|\/)[^/]+_spec\.(?:py|rb)$/i,
];

/**
 * Self-verification authority must not be rewritten by a self-target proposal.
 * The runner executes verifier commands in the candidate worktree, so allowing
 * this file through would let the proposal change the process that reports
 * verification success. Broader verifier authority is bound by the merge
 * snapshot; this is the immediate self-hosting fence.
 */
const SELF_VERIFICATION_AUTHORITY_FILES = new Set([
  'scripts/run-verify-command.mjs',
]);

function isSelfVerificationAuthorityFile(path: string): boolean {
  return SELF_VERIFICATION_AUTHORITY_FILES.has(path.replace(/^\.\//, ''));
}

/** Whether a repo-relative path names a safety/invariant test file. */
export function isSafetyTestFile(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return SAFETY_FILE_PATTERNS.some((re) => re.test(p));
}

/** Whether a repo-relative path is ordinary executable test infrastructure. */
export function isOrdinaryTestFile(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  const segments = p.split('/');
  const basename = segments.at(-1) ?? '';
  return (
    segments.slice(0, -1).some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase())) ||
    ORDINARY_TEST_FILE_PATTERNS.some((re) => re.test(basename) || re.test(p))
  );
}

function isProtectedTestFile(path: string): boolean {
  return isSafetyTestFile(path) || isOrdinaryTestFile(path);
}

/** Lines that represent a test assertion or block — the protected substance. */
const ASSERTION_RE =
  /^\s*(?:(?:await|return|void)\s+)?(?:it|test|describe|context|specify|expect|assert)\b|^\s*(?:self\.)?(?:assert|refute)[A-Z_a-z]\w*\b|^\s*(?:t|tb)\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|^\s*(?:require|assert)\.\w+\b|^\s*#\[(?:test|rstest|tokio::test)\]|^\s*(?:assert|debug_assert)(?:_eq|_ne)?!\s*\(|^\s*(?:\)|\.)\s*\.(?:not|resolves|rejects|to[A-Z]\w*)\b|^\s*(?:toBe|toEqual|toThrow|toMatch)\b/;
const SKIPPED_OR_ONLY_TEST_RE =
  /^\s*(?:describe|it|test|context|specify)(?:\.\w+)*\.(?:skip|only|skipIf)\b|^\s*(?:xdescribe|xit|xtest|skipIf)\s*\(|^\s*(?:@pytest\.mark\.(?:skip|skipif)|@unittest\.skip)|^\s*(?:t|tb)\.Skip(?:f|Now)?\s*\(/;

export interface SafetyGuardVerdict {
  /** True ⇒ the diff weakens a safety guarantee and MUST be refused. */
  weakened: boolean;
  reason: string;
  /** Safety files the diff touched (for the audit trail). */
  files: string[];
}

interface FileDiff {
  path: string;
  oldPath: string;
  newPath: string;
  deleted: boolean;
  addedAssertions: number;
  removedAssertions: number;
  removedAssertionLines: string[];
  addedSkippedOrOnlyTests: string[];
}

const GIT_PATH_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Decode Git's C-quoted path format without invoking Git or the filesystem. */
function decodeGitPath(input: string): string {
  if (!input.startsWith('"')) return input;
  if (!input.endsWith('"')) throw new Error('unterminated quoted Git path');
  const bytes: number[] = [];
  for (let index = 1; index < input.length - 1;) {
    const char = input[index]!;
    if (char !== '\\') {
      const literal = String.fromCodePoint(input.codePointAt(index)!);
      bytes.push(...Buffer.from(literal));
      index += literal.length;
      continue;
    }
    const escaped = input[++index];
    if (escaped === undefined) throw new Error('unterminated Git path escape');
    index++;
    const simple = GIT_PATH_ESCAPES[escaped];
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }
    if (!/[0-7]/.test(escaped)) throw new Error('invalid Git path escape');
    let octal = escaped;
    while (index < input.length - 1 && octal.length < 3 && /[0-7]/.test(input[index]!)) {
      octal += input[index++]!;
    }
    const value = Number.parseInt(octal, 8);
    if (value > 255) throw new Error('invalid Git path escape');
    bytes.push(value);
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  if (decoded.includes('\ufffd')) throw new Error('invalid UTF-8 Git path');
  return decoded;
}

function metadataPath(input: string, prefix?: 'a' | 'b'): string {
  const decoded = decodeGitPath(input);
  if (!prefix) return decoded;
  if (!decoded.startsWith(`${prefix}/`)) throw new Error('invalid Git path prefix');
  return decoded.slice(2);
}

/** Split a unified diff into per-file sections and tally assertion deltas. */
function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (cur) files.push(cur);
      // `diff --git a/<path> b/<path>` — take the b/ path.
      const m = line.match(/ b\/(.+)$/);
      cur = {
        path: m ? m[1]! : '',
        oldPath: '',
        newPath: m ? m[1]! : '',
        deleted: false,
        addedAssertions: 0,
        removedAssertions: 0,
        removedAssertionLines: [],
        addedSkippedOrOnlyTests: [],
      };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('deleted file mode')) {
      cur.deleted = true;
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      cur.deleted = true;
      cur.newPath = '';
      continue;
    }
    // Path metadata is authoritative for deletion and rename-out detection.
    if (line.startsWith('--- ') && line !== '--- /dev/null') {
      cur.oldPath = metadataPath(line.slice('--- '.length), 'a');
      continue;
    }
    if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      cur.path = metadataPath(line.slice('+++ '.length), 'b');
      cur.newPath = cur.path;
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.oldPath = metadataPath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.path = metadataPath(line.slice('rename to '.length));
      cur.newPath = cur.path;
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+')) {
      const content = line.slice(1);
      if (ASSERTION_RE.test(content)) cur.addedAssertions++;
      if (SKIPPED_OR_ONLY_TEST_RE.test(content)) cur.addedSkippedOrOnlyTests.push(content.trim());
    } else if (line.startsWith('-')) {
      const content = line.slice(1);
      if (ASSERTION_RE.test(content)) {
        cur.removedAssertions++;
        cur.removedAssertionLines.push(content.trim());
      }
    }
  }
  if (cur) files.push(cur);
  return files;
}

/**
 * The never-weaken guard. Refuses (weakened:true) when the diff:
 *   - deletes a safety/invariant test file, OR
 *   - removes assertions from a safety/invariant test file, OR
 *   - adds focused/skipped test declarations in a safety/invariant test file.
 * Conservative by design: a diff that touches a safety file and removes
 * protected assertion substance is refused even if it also adds unrelated code.
 * PURE; never throws.
 */
export function guardSafetyTests(diff: string): SafetyGuardVerdict {
  const touched: string[] = [];
  if (!diff || !diff.trim()) return { weakened: false, reason: 'empty diff', files: [] };
  let parsed: FileDiff[];
  try {
    parsed = parseDiff(diff);
  } catch {
    // Unparseable diff over self ⇒ refuse (ambiguous = unsafe).
    return { weakened: true, reason: 'unparseable diff over self-target — refused', files: [] };
  }
  for (const f of parsed) {
    if (f.path && isSelfVerificationAuthorityFile(f.path)) {
      touched.push(f.path);
      return {
        weakened: true,
        reason: `diff touches self-verification authority '${f.path}' — refused`,
        files: touched,
      };
    }
    const protectedPaths = [...new Set([f.oldPath, f.newPath, f.path].filter(isProtectedTestFile))];
    if (protectedPaths.length === 0) continue;
    touched.push(...protectedPaths.filter((path) => !touched.includes(path)));
    const protectedOldPath = f.oldPath && isProtectedTestFile(f.oldPath) ? f.oldPath : '';
    const renamedOutOfTests = Boolean(
      protectedOldPath && f.newPath && !isProtectedTestFile(f.newPath),
    );
    const displayPath = protectedOldPath || protectedPaths[0]!;
    const safetyLabel = isSafetyTestFile(displayPath) ? 'safety/invariant test' : 'test';
    if (f.deleted || renamedOutOfTests) {
      return {
        weakened: true,
        reason: renamedOutOfTests
          ? `diff renames test file '${displayPath}' outside test coverage — refused`
          : `diff deletes ${safetyLabel} file '${displayPath}' — refused`,
        files: touched,
      };
    }
    if (f.addedSkippedOrOnlyTests.length > 0) {
      return {
        weakened: true,
        reason: `diff adds skipped/focused test declaration in '${displayPath}' — refused`,
        files: touched,
      };
    }
    if (f.removedAssertions > 0) {
      return {
        weakened: true,
        reason: `diff removes ${f.removedAssertions} assertion(s) from ${safetyLabel} '${displayPath}' — refused`,
        files: touched,
      };
    }
  }
  return { weakened: false, reason: 'no protected test weakened', files: touched };
}

// ---------------------------------------------------------------------------
// Self-eval parity harness
// ---------------------------------------------------------------------------

export interface SelfEvalVerdict {
  ok: boolean;
  reason: string;
}

/**
 * The self-eval harness contract: a self-target change is eligible only when the
 * invariant suite is green with the foundry flag OFF *and* ON. `runSuite(flagOn)`
 * runs the suite in the (already diff-applied) sandbox worktree and returns
 * whether it passed. PURE over its injected runner; never throws — a runner that
 * throws counts as a failing suite (fail-closed).
 */
export function selfEvalParity(runSuite: (flagOn: boolean) => boolean): SelfEvalVerdict {
  let offGreen: boolean;
  let onGreen: boolean;
  try {
    offGreen = runSuite(false);
  } catch {
    offGreen = false;
  }
  if (!offGreen) {
    return { ok: false, reason: 'invariant suite not green with foundry flag OFF' };
  }
  try {
    onGreen = runSuite(true);
  } catch {
    onGreen = false;
  }
  if (!onGreen) {
    return { ok: false, reason: 'invariant suite not green with foundry flag ON' };
  }
  return { ok: true, reason: 'invariant suite green flag-off AND flag-on' };
}

/** Async variant for callers whose suite runner must not block daemon timers. */
export async function selfEvalParityAsync(
  runSuite: (flagOn: boolean) => boolean | Promise<boolean>,
): Promise<SelfEvalVerdict> {
  let offGreen: boolean;
  let onGreen: boolean;
  try {
    offGreen = await runSuite(false);
  } catch {
    offGreen = false;
  }
  if (!offGreen) {
    return { ok: false, reason: 'invariant suite not green with foundry flag OFF' };
  }
  try {
    onGreen = await runSuite(true);
  } catch {
    onGreen = false;
  }
  if (!onGreen) {
    return { ok: false, reason: 'invariant suite not green with foundry flag ON' };
  }
  return { ok: true, reason: 'invariant suite green flag-off AND flag-on' };
}
