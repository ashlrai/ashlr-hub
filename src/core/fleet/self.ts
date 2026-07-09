/**
 * self.ts — M54 (v5 Open Fleet): the self-improving fleet's safety harness.
 *
 * The fleet may modify ashlr-hub's OWN source, but it may NEVER weaken its own
 * safety guarantees. Two pure mechanisms enforce that:
 *
 *   1. `guardSafetyTests(diff)` — the never-weaken guard. Refuses, BY CONSTRUCTION
 *      and BEFORE any verification runs, any diff that deletes a safety/invariant
 *      test file, removes assertions from one, or focuses/skips safety tests. A
 *      self-authored change can fix bugs and add tests, but can never disarm the
 *      gates that keep the fleet safe.
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

/** Whether a repo-relative path names a safety/invariant test file. */
export function isSafetyTestFile(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return SAFETY_FILE_PATTERNS.some((re) => re.test(p));
}

/** Lines that represent a test assertion or block — the protected substance. */
const ASSERTION_RE =
  /^\s*(?:(?:await|return|void)\s+)?(?:it|test|describe|expect|assert)\b|^\s*(?:\)|\.)\s*\.(?:not|resolves|rejects|to[A-Z]\w*)\b|^\s*(?:toBe|toEqual|toThrow|toMatch)\b/;
const SKIPPED_OR_ONLY_TEST_RE =
  /^\s*(?:describe|it|test)(?:\.\w+)*\.(?:skip|only|skipIf)\b|^\s*skipIf\s*\(/;

export interface SafetyGuardVerdict {
  /** True ⇒ the diff weakens a safety guarantee and MUST be refused. */
  weakened: boolean;
  reason: string;
  /** Safety files the diff touched (for the audit trail). */
  files: string[];
}

interface FileDiff {
  path: string;
  deleted: boolean;
  addedAssertions: number;
  removedAssertions: number;
  removedAssertionLines: string[];
  addedSkippedOrOnlyTests: string[];
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
      continue;
    }
    // `--- a/path` / `+++ b/path` headers are not content; refine the path from +++.
    if (line.startsWith('+++ b/')) {
      cur.path = line.slice('+++ b/'.length);
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
    if (!f.path || !isSafetyTestFile(f.path)) continue;
    touched.push(f.path);
    if (f.deleted) {
      return {
        weakened: true,
        reason: `diff deletes safety/invariant test file '${f.path}' — refused`,
        files: touched,
      };
    }
    if (f.addedSkippedOrOnlyTests.length > 0) {
      return {
        weakened: true,
        reason: `diff adds skipped/focused safety test declaration in '${f.path}' — refused`,
        files: touched,
      };
    }
    if (f.removedAssertions > 0) {
      return {
        weakened: true,
        reason: `diff removes ${f.removedAssertions} assertion(s) from safety test '${f.path}' — refused`,
        files: touched,
      };
    }
  }
  return { weakened: false, reason: 'no safety test weakened', files: touched };
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
