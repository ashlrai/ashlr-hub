/**
 * value-filter.ts — Triviality predicate for backlog work items.
 *
 * GUARDRAILS:
 *  - Pure, deterministic, no I/O.
 *  - Does NOT flag real work: bug fixes, failing-test specifics, security items,
 *    dep bumps with breaking notes, lint errors with a rule/file, performance
 *    regressions with a measurement, feature requests with a concrete spec.
 *  - Only drops items that provably cannot yield a valuable diff.
 */

import type { WorkItem } from '../types.js';

// ---------------------------------------------------------------------------
// Non-code path detection (M133)
// ---------------------------------------------------------------------------

/**
 * File-path segments / patterns that identify non-code / low-value files where
 * TODO/FIXME markers are almost never actionable code work.
 *
 * NOTE: this is DISTINCT from M108's isIgnoredPath (generated/lockfiles that
 * are not scanned at all). These files ARE scanned, but markers inside them
 * are down-valued to trivial so the min-value gate drops them.
 *
 * Matches any path whose:
 *  - extension is .md / .txt / .rst / .adoc
 *  - basename starts with CHANGELOG
 *  - any path segment is docs/, examples/, fixtures/
 *  - basename matches *.test.* or *.spec.*
 *  - any path segment is test/ or tests/ or __tests__/
 */
export const NON_CODE_PATH_RE =
  /(?:^|\/)(?:CHANGELOG[^/]*|docs\/|examples\/|fixtures\/|test\/|tests\/|__tests__\/)|\.(?:md|txt|rst|adoc)$|\.(?:test|spec)\.[^/]+$/i;

/**
 * Returns true when a raw file path string is a non-code/low-value path.
 * Used directly by scanners.ts to down-value markers before building WorkItems.
 */
export function isNonCodePath(filePath: string): boolean {
  return NON_CODE_PATH_RE.test(filePath.replace(/\\/g, '/'));
}

/**
 * Returns true when the file path referenced in a marker item is a non-code
 * path (docs, changelog, tests, plain-text files). Markers in these paths
 * are low-value by definition.
 *
 * Applies to items whose title matches "N marker(s) in <path>" — extracts
 * the file path from the title and tests it.
 */
export function isNonCodeMarkerItem(item: WorkItem): boolean {
  if (!BARE_MARKER_TITLE_RE.test(item.title)) return false;
  // Extract the file path portion: everything after "N marker(s) in "
  const match = item.title.match(/^\d+ markers? in ([^\s:]+)/i);
  if (!match) return false;
  const filePath = match[1]!;
  return NON_CODE_PATH_RE.test(filePath);
}

// ---------------------------------------------------------------------------
// Patterns — each pattern is narrow and well-motivated.
// ---------------------------------------------------------------------------

/**
 * Bare marker titles: "1 marker in src/foo.ts:17" or "2 markers in lib/bar.ts"
 * with no actionable description beyond the marker count and file reference.
 *
 * The discriminating signal is:
 *   - Title is ONLY "N marker(s) in <file>[:line]" — nothing else.
 *   - AND the detail's quoted TODO text is a bare placeholder
 *     (no verb, no object, no specific what-to-do).
 */
const BARE_MARKER_TITLE_RE = /^\d+ markers? in /i;

/**
 * Comment-only / doc-comment requests. Phrases that signal the sole requested
 * action is to add a comment, JSDoc, module doc, or docstring.
 */
const COMMENT_ONLY_RE =
  /\b(add\s+(a\s+)?(doc[\s-]?comment|jsdoc|module\s+doc|docstring|comment)|write\s+(a\s+)?doc[\s-]?comment|document\s+this\s+(function|method|class|module)|missing\s+(jsdoc|docstring|module\s+doc))\b/i;

/**
 * Vague / unspecific CI-failure signals with no actionable content.
 * "CI is failing" / "CI failed" / "build is failing" WITHOUT a specific
 * job name, file, error message, or test name following immediately.
 *
 * We ONLY flag a match when the whole title/detail lacks specifics.
 * A real item will contain a file path, error text, or test name.
 */
const VAGUE_CI_RE = /\b(ci|build|pipeline)\s+(is\s+)?(failing|failed|broken)\b/i;

/**
 * Whitespace / formatting only: title signals the only change is whitespace,
 * indentation, or trailing-space cleanup with no semantic content.
 */
const FORMAT_ONLY_RE =
  /\b(fix\s+(trailing\s+)?whitespace|remove\s+trailing\s+whitespace|fix\s+indentation|normalize\s+line\s+endings|trim\s+trailing\s+spaces)\b/i;

/**
 * Bare placeholder TODO texts: the quoted content inside the detail is just
 * a filler phrase like "TODO:", "TODO: handle other cases", "TODO: implement",
 * "TODO: refactor", "FIXME:", "HACK:", with no concrete noun/verb after.
 * These indicate the developer left a stub and there is nothing actionable.
 */
const BARE_TODO_TEXT_RE =
  /[""]?\s*(TODO|FIXME|HACK|XXX)\s*:?\s*(handle\s+(other\s+)?cases?|implement(\s+this)?|refactor(\s+this)?|fix(\s+this)?|update(\s+this)?|cleanup|clean\s+up|later|tbd|remove\s+this|needs?\s+work|placeholder|stub|todo\s+here|fixme\s+here)?\s*[""]?$/i;

/**
 * Single-token / trivial change hints in the title: wording that reveals
 * the only change is one token, one import, one rename with no logic change.
 */
const SINGLE_TOKEN_RE =
  /\b(rename\s+(a\s+)?variable|add\s+(a\s+)?missing\s+semicolon|add\s+(a\s+)?trailing\s+comma)\b/i;

// ---------------------------------------------------------------------------
// Allowlist: patterns that PREVENT trivial classification regardless of title.
// A match on the detail means the item is substantive. Order matters — first
// match wins (item is NOT trivial).
// ---------------------------------------------------------------------------

/** Security-related items always pass through. */
const SECURITY_ALLOW_RE =
  /\b(vuln(erability)?|cve-\d|security|exploit|injection|xss|csrf|auth(enticati)?|privilege|escape|sanitiz|taint)\b/i;

/** Breaking-change dep bumps pass through. */
const BREAKING_DEP_RE = /\bbreaking\b|\bmigration\s+guide\b|\bbreaking\s+change\b/i;

/** Specific failing test names pass through — real test identifiers. */
const SPECIFIC_TEST_RE = /\b(test|spec|it|describe)\s*\(/i;

/** File+line references signal concrete source location — real work. */
const FILE_LINE_RE = /[a-zA-Z0-9_./-]+\.[a-z]{1,5}:\d+/;

/** Measurement / metric signals indicate a real perf regression. */
const METRIC_RE = /\b\d+(\.\d+)?\s*(ms|seconds?|s|kb|mb|gb|%)\b/i;

// ---------------------------------------------------------------------------
// isTrivialItem
// ---------------------------------------------------------------------------

export interface TrivialResult {
  trivial: boolean;
  reason?: string;
}

/**
 * Returns `{ trivial: true, reason }` when the item is unlikely to yield a
 * valuable diff; `{ trivial: false }` otherwise.
 *
 * Decision logic (short-circuit):
 *  1. Security items → never trivial (high-value even when brief).
 *  2. Breaking-dep → never trivial.
 *  3. Item with specific file:line reference → likely concrete, not trivial.
 *  4. Specific test failure reference → not trivial.
 *  5. Performance measurement → not trivial.
 *  Then apply triviality patterns in order.
 */
export function isTrivialItem(item: WorkItem): TrivialResult {
  const fullText = `${item.title} ${item.detail}`;

  // ── Allowlist: never trivial ────────────────────────────────────────────

  if (SECURITY_ALLOW_RE.test(fullText)) {
    return { trivial: false };
  }
  if (BREAKING_DEP_RE.test(fullText)) {
    return { trivial: false };
  }

  // M133: Markers in non-code/low-value files (docs, CHANGELOG, tests, .md, .txt,
  // examples, fixtures) are trivial regardless of their quoted text. Check this
  // BEFORE the bare-marker text gate so a "substantive" description in CHANGELOG.md
  // is still dropped — markers in these files are editorial noise, not code work.
  if (isNonCodeMarkerItem(item)) {
    return { trivial: true, reason: 'non-code-marker: TODO/FIXME in docs/changelog/test/txt file is not actionable code work' };
  }

  // Bare TODO marker -> trivial EVEN IF it references a file:line (a marker's
  // location is not "actionable specifics"). MUST run before the file:line allowlist.
  if (BARE_MARKER_TITLE_RE.test(item.title)) {
    const quoted = item.detail.match(/"([^"]{0,200})"/)?.[1] ?? '';
    if (BARE_TODO_TEXT_RE.test(quoted) || quoted.trim().length === 0) {
      return { trivial: true, reason: 'bare-todo-marker: no actionable description' };
    }
    const stripped = quoted.replace(/^(TODO|FIXME|HACK|XXX)\s*:?\s*/i, '').trim();
    if (stripped.split(/\s+/).length <= 3) {
      return { trivial: true, reason: 'bare-todo-marker: description too short to be actionable' };
    }
  }

  // -- Allowlist: file:line / specific test / metric -> not trivial --
  if (FILE_LINE_RE.test(fullText)) {
    return { trivial: false };
  }
  if (SPECIFIC_TEST_RE.test(item.detail)) {
    return { trivial: false };
  }
  if (METRIC_RE.test(fullText)) {
    return { trivial: false };
  }

  // -- Triviality patterns --
  // 2. Comment / doc-comment only request
  if (COMMENT_ONLY_RE.test(item.title) || COMMENT_ONLY_RE.test(item.detail)) {
    return { trivial: true, reason: 'comment-only: sole request is to add a doc-comment or inline comment' };
  }

  // 3. Vague CI failure with no specific content
  if (VAGUE_CI_RE.test(item.title)) {
    // Only trivial if the detail also lacks file/error specifics
    const detailHasSpecifics =
      FILE_LINE_RE.test(item.detail) ||
      /\b(error|exception|failed\s+test|job\s+name|step\s+name|workflow|\.yml|\.yaml)\b/i.test(item.detail);
    if (!detailHasSpecifics) {
      return { trivial: true, reason: 'vague-ci: no specific file, error, or test mentioned' };
    }
  }

  // 4. Whitespace / formatting only
  if (FORMAT_ONLY_RE.test(item.title) || FORMAT_ONLY_RE.test(item.detail)) {
    return { trivial: true, reason: 'format-only: whitespace or indentation change with no semantic content' };
  }

  // 5. Single-token change
  if (SINGLE_TOKEN_RE.test(item.title)) {
    return { trivial: true, reason: 'single-token: only a rename or punctuation change' };
  }

  // 6. Value=1 items with very short titles (no detail to redeem them)
  if (item.value <= 1 && item.title.split(/\s+/).length <= 4 && item.detail.trim().length < 40) {
    return { trivial: true, reason: 'low-value-stub: value=1 with no meaningful detail' };
  }

  return { trivial: false };
}
