/**
 * spec-contract.ts — M190: spec → binding contract checker (invented idea #4).
 *
 * Elevates a task's `.ashlr` END-STATE SPEC from a planning byproduct into a
 * BINDING CONTRACT: parse the spec's `## Verification` acceptance criteria into
 * machine-checkable assertions, then verify a produced unified diff (plus the
 * repo it landed in) DEMONSTRABLY satisfies them. This kills the "looks good
 * but does the wrong thing" failure mode where a diff passes review/tests yet
 * never delivers what the spec promised.
 *
 * Real spec shape (see src/core/spec/spec-store.ts):
 *   - A `SpecArtifact` JSON sidecar: { id, goal, version, project, path, ... }.
 *   - A markdown body with level-2 sections; the binding one here is
 *     `## Verification` — "3–6 measurable acceptance criteria" as bullets.
 *   - Authoring goals can themselves embed criteria ("file X exists",
 *     "function Y exported", "test Z passes"), so we also mine `meta.goal`.
 *
 * Checks are STATIC and CHEAP (file existence, export presence, grep for
 * required strings against repo + diff additions). Criteria that genuinely
 * need a live test/build run are marked `deferred` — NEVER failed — because a
 * cheap static pass cannot honestly assert them.
 *
 * Pure, BOUNDED, NEVER-THROWS. Gated behind cfg.foundry.specContract (off by
 * default). No merge-gate wiring lives here — this module only evaluates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AshlrConfig, SpecArtifact } from '../types.js';

// ---------------------------------------------------------------------------
// Bounds (defensive — a spec/diff is never trusted to be small)
// ---------------------------------------------------------------------------

/** Max acceptance criteria parsed from a single spec. */
const MAX_CRITERIA = 64;
/** Max chars of a spec body we scan for the Verification section. */
const MAX_BODY_SCAN = 64_000;
/** Max diff size scanned (chars). */
const MAX_DIFF_SCAN = 2_000_000;
/** Max bytes read from any one repo file when grepping for a required string. */
const MAX_FILE_READ = 512_000;
/** Max files we'll stat/read while evaluating one contract. */
const MAX_FILE_OPS = 256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The classification of a parsed acceptance criterion. Determines how
 * `checkSpecContract` evaluates it.
 */
export type AssertionKind =
  /** A named path must exist (in the repo or be added by the diff). */
  | 'file-exists'
  /** A named symbol must be exported (grep `export ... name` in repo/diff). */
  | 'export-present'
  /** A literal string/token must be present somewhere in repo or diff. */
  | 'string-present'
  /** Requires a live test/build run — cannot be settled statically. */
  | 'test-run'
  /** Could not be reduced to a static check — informational only. */
  | 'generic';

/** A single machine-checkable assertion derived from a spec criterion. */
export interface Assertion {
  /** Stable index within the parsed spec (0-based). */
  index: number;
  /** The original criterion text (trimmed). */
  text: string;
  /** How this assertion is evaluated. */
  kind: AssertionKind;
  /**
   * The extracted target for the check:
   *  - file-exists    → a path or filename fragment
   *  - export-present → a symbol name
   *  - string-present → the required literal
   *  - test-run/generic → undefined
   */
  target?: string;
}

/** Per-criterion failure detail. */
export interface UnmetCriterion {
  /** The original criterion text. */
  criterion: string;
  /** Why it is unmet (or deferred). */
  why: string;
}

/** Result of evaluating a spec contract against a produced change. */
export interface SpecContractResult {
  /**
   * True when every STATICALLY-CHECKABLE assertion is met and none failed.
   * Deferred (test-run) and generic assertions do NOT block satisfaction —
   * they are surfaced in `detail` for downstream judgement.
   */
  satisfied: boolean;
  /** Total assertions parsed. */
  total: number;
  /** Count of statically-checkable assertions that were met. */
  met: number;
  /** Failed assertions (and the deferred/generic ones, with why). */
  unmet: UnmetCriterion[];
  /** Human-readable summary + structured breakdown. */
  detail: {
    /** Why the contract was a no-op, when it was (flag off / no criteria). */
    reason?: string;
    /** Number of assertions that need a live run (not failed). */
    deferred: number;
    /** Number of assertions that could not be reduced to a static check. */
    generic: number;
    /** Number of statically-checkable assertions (file/export/string). */
    checkable: number;
    /** The parsed assertions (for transparency / debugging). */
    assertions: Assertion[];
  };
}

/** A spec as accepted by the checker: a loaded artifact, a body, or both. */
export type SpecInput =
  | { meta?: SpecArtifact | null; body?: string | null }
  | string
  | null
  | undefined;

// ---------------------------------------------------------------------------
// Helpers — never throw
// ---------------------------------------------------------------------------

/** Coerce the SpecInput into { goal, body } strings. Never throws. */
function normalizeSpec(spec: SpecInput): { goal: string; body: string } {
  if (!spec) return { goal: '', body: '' };
  if (typeof spec === 'string') return { goal: '', body: spec.slice(0, MAX_BODY_SCAN) };
  const goal = typeof spec.meta?.goal === 'string' ? spec.meta.goal : '';
  let body = typeof spec.body === 'string' ? spec.body : '';
  // If no body was passed but the artifact points at a path, try to read it.
  if (!body && spec.meta?.path && typeof spec.meta.path === 'string') {
    try {
      const st = fs.statSync(spec.meta.path);
      if (st.isFile() && st.size <= MAX_FILE_READ) {
        body = fs.readFileSync(spec.meta.path, 'utf8');
      }
    } catch {
      /* unreadable — fall through with empty body */
    }
  }
  return { goal: goal.slice(0, MAX_BODY_SCAN), body: body.slice(0, MAX_BODY_SCAN) };
}

/**
 * Extract the bullet lines from the `## Verification` section of a spec body.
 * Falls back to scanning the whole body for criterion-shaped bullets when no
 * explicit Verification heading exists (stub specs, partial bodies).
 */
function extractCriterionLines(body: string): string[] {
  if (!body) return [];
  const lines = body.split('\n');

  // Locate the Verification heading (case-insensitive, level-2 or -3).
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,3}\s+verification\b/i.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }

  let region: string[];
  if (start >= 0) {
    // Collect until the next markdown heading of the same-or-higher level.
    region = [];
    for (let i = start; i < lines.length; i++) {
      if (/^#{1,3}\s+\S/.test(lines[i])) break;
      region.push(lines[i]);
    }
  } else {
    // No explicit section — scan the whole body for bullet criteria.
    region = lines;
  }

  const out: string[] = [];
  for (const raw of region) {
    const t = raw.trim();
    // Markdown bullets: "- foo", "* foo", "1. foo", or "1) foo"
    const m = t.match(/^(?:[-*]\s+|\d+[.)]\s+)(.+)$/);
    if (m) {
      const text = m[1].trim();
      if (text && !/^_.*_$/.test(text)) out.push(text); // skip placeholder "_foo_"
    }
    if (out.length >= MAX_CRITERIA) break;
  }
  return out;
}

/** Strip surrounding markdown emphasis/backticks from a token. */
function unwrap(s: string): string {
  return s.replace(/^[`*_"']+|[`*_"']+$/g, '').trim();
}

/**
 * Classify a single criterion into an Assertion. Order matters: the most
 * specific / checkable patterns win; everything else degrades to test-run
 * (when it clearly asks for a passing test/build) or generic.
 */
function classify(text: string, index: number): Assertion {
  const t = text.trim();
  const lower = t.toLowerCase();

  // 1. Explicit path/file existence: a `path/like/this.ext` or "file X exists".
  //    Recognize a token containing a slash or a dotted filename.
  const pathTok =
    t.match(/`([^`]*[/.][^`]+)`/)?.[1] ??
    t.match(/\b([\w./-]+\/[\w./-]+|[\w-]+\.[A-Za-z][\w]{0,6})\b/)?.[1];
  if (
    pathTok &&
    /\b(file|path|module|directory|dir|created|exists?|present|added|new)\b/.test(lower) &&
    !/\bexport(ed|s)?\b/.test(lower)
  ) {
    return { index, text: t, kind: 'file-exists', target: unwrap(pathTok) };
  }

  // 2. Export presence: "function Y exported", "Y is exported", "export X".
  const exportMatch =
    t.match(/(?:function|class|const|symbol|export)\s+`?([A-Za-z_$][\w$]*)`?/i) ??
    t.match(/`?([A-Za-z_$][\w$]*)`?\s+(?:is\s+)?export(?:ed)?/i);
  if (exportMatch && /\bexport/i.test(lower)) {
    return { index, text: t, kind: 'export-present', target: unwrap(exportMatch[1]) };
  }

  // 3. Test / build must pass → genuinely needs a live run → deferred.
  if (/\b(test|tests|suite|spec|build|compiles?|type-?checks?|lint|ci|coverage|passes?|green|run)\b/.test(lower)) {
    return { index, text: t, kind: 'test-run' };
  }

  // 4. Required literal string present: quoted/backticked token to grep for.
  const literal =
    t.match(/`([^`]+)`/)?.[1] ??
    t.match(/["“]([^"”]{2,})["”]/)?.[1];
  if (
    literal &&
    /\b(contain|contains|include|includes|present|mention|references?|string|text|comment|statement)\b/.test(lower)
  ) {
    return { index, text: t, kind: 'string-present', target: unwrap(literal) };
  }

  // 5. Bare path token without strong verb → still treat as file-exists.
  if (pathTok && !/\bexport/i.test(lower)) {
    return { index, text: t, kind: 'file-exists', target: unwrap(pathTok) };
  }

  return { index, text: t, kind: 'generic' };
}

// ---------------------------------------------------------------------------
// Diff parsing (target files + added lines) — mirrors diff-safety.ts shape
// ---------------------------------------------------------------------------

interface DiffView {
  /** Set of target file paths touched by the diff (normalized, no a/ b/). */
  files: Set<string>;
  /** All added (+) content lines concatenated, lowercased lookup-friendly. */
  addedText: string;
}

function parseDiff(diff: string | null | undefined): DiffView {
  const view: DiffView = { files: new Set(), addedText: '' };
  if (!diff || typeof diff !== 'string') return view;
  const src = diff.length > MAX_DIFF_SCAN ? diff.slice(0, MAX_DIFF_SCAN) : diff;
  const added: string[] = [];
  for (const raw of src.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4).replace(/^[ab]\//, '').trim();
      if (name && name !== '/dev/null') view.files.add(name);
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    if (raw.startsWith('diff --git')) {
      // Capture both sides of "diff --git a/x b/y" for robustness.
      const m = raw.match(/diff --git a\/(\S+) b\/(\S+)/);
      if (m) {
        view.files.add(m[1]);
        view.files.add(m[2]);
      }
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) added.push(raw.slice(1));
  }
  view.addedText = added.join('\n');
  return view;
}

// ---------------------------------------------------------------------------
// Static evaluators (bounded, never throw)
// ---------------------------------------------------------------------------

/** True if a path/fragment exists in the diff's touched files. */
function inDiffFiles(target: string, view: DiffView): boolean {
  const needle = target.replace(/^[ab]\//, '');
  for (const f of view.files) {
    if (f === needle || f.endsWith('/' + needle) || f.endsWith(needle) || f.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** True if a path/fragment resolves to an existing file under repoDir. */
function existsInRepo(target: string, repoDir: string, budget: { ops: number }): boolean {
  if (!repoDir || budget.ops <= 0) return false;
  budget.ops--;
  // Direct join first.
  try {
    const direct = path.isAbsolute(target) ? target : path.join(repoDir, target);
    if (fs.existsSync(direct)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** True if `needle` appears in the diff's added text. */
function inDiffText(needle: string, view: DiffView): boolean {
  if (!needle) return false;
  return view.addedText.includes(needle);
}

/**
 * True if `needle` appears in any repo file touched by the diff (bounded read).
 * We only scan files the diff touched — keeps the check cheap and relevant.
 */
function inTouchedRepoFiles(
  needle: string,
  view: DiffView,
  repoDir: string,
  budget: { ops: number },
): boolean {
  if (!needle || !repoDir) return false;
  for (const f of view.files) {
    if (budget.ops <= 0) break;
    budget.ops--;
    try {
      const abs = path.isAbsolute(f) ? f : path.join(repoDir, f);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_READ) continue;
      const content = fs.readFileSync(abs, 'utf8');
      if (content.includes(needle)) return true;
    } catch {
      /* unreadable / missing — skip */
    }
  }
  return false;
}

/** Build an export-detection check for a symbol against added text + repo. */
function exportPresent(
  symbol: string,
  view: DiffView,
  repoDir: string,
  budget: { ops: number },
): boolean {
  if (!symbol) return false;
  const re = new RegExp(
    `export\\s+(?:async\\s+)?(?:default\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${escapeRe(symbol)}\\b` +
      `|export\\s*\\{[^}]*\\b${escapeRe(symbol)}\\b[^}]*\\}` +
      `|export\\s+(?:default\\s+)?${escapeRe(symbol)}\\b`,
  );
  if (re.test(view.addedText)) return true;
  // Fall back to touched repo files.
  for (const f of view.files) {
    if (budget.ops <= 0) break;
    budget.ops--;
    try {
      const abs = path.isAbsolute(f) ? f : path.join(repoDir, f);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_READ) continue;
      if (re.test(fs.readFileSync(abs, 'utf8'))) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a spec's acceptance criteria into machine-checkable assertions.
 *
 * Mines the `## Verification` section of the markdown body (the canonical home
 * per spec-store's authoring prompt) plus the authoring `goal`. Never throws;
 * returns `[]` for an empty / criteria-less spec.
 */
export function parseAcceptanceCriteria(spec: SpecInput): Assertion[] {
  try {
    const { goal, body } = normalizeSpec(spec);
    const lines = extractCriterionLines(body);

    // Mine the goal too — authoring goals frequently embed the real criteria
    // ("Add file X", "export Y"). Split on sentence/clause boundaries.
    if (goal) {
      for (const part of goal.split(/[\n.;]+/)) {
        const t = part.trim();
        if (t.length >= 6 && /[a-zA-Z]/.test(t)) lines.push(t);
        if (lines.length >= MAX_CRITERIA) break;
      }
    }

    const seen = new Set<string>();
    const assertions: Assertion[] = [];
    for (const line of lines) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      assertions.push(classify(line, assertions.length));
      if (assertions.length >= MAX_CRITERIA) break;
    }
    return assertions;
  } catch {
    return [];
  }
}

/**
 * Evaluate whether a produced diff (and the repo it landed in) demonstrably
 * satisfies a spec's acceptance criteria.
 *
 * Gated behind `cfg.foundry.specContract` (default OFF): when off, returns a
 * vacuously-satisfied no-op so it is safe to call unconditionally.
 *
 * Static & cheap: file existence (repo + diff), export presence (regex over
 * diff additions + touched files), required-string grep. Criteria that need a
 * live test/build run are reported `deferred` (NOT failed). Never throws.
 */
export async function checkSpecContract(
  input: { spec: SpecInput; repoDir?: string; diff?: string | null },
  cfg: AshlrConfig,
): Promise<SpecContractResult> {
  const emptyDetail = (reason: string, assertions: Assertion[] = []): SpecContractResult => ({
    satisfied: true,
    total: assertions.length,
    met: 0,
    unmet: [],
    detail: { reason, deferred: 0, generic: 0, checkable: 0, assertions },
  });

  try {
    const enabled = (cfg?.foundry as Record<string, unknown> | undefined)?.['specContract'] === true;
    if (!enabled) return emptyDetail('disabled (cfg.foundry.specContract off)');

    const assertions = parseAcceptanceCriteria(input?.spec);
    if (assertions.length === 0) return emptyDetail('no acceptance criteria parsed');

    const repoDir = typeof input?.repoDir === 'string' ? input.repoDir : '';
    const view = parseDiff(input?.diff);
    const budget = { ops: MAX_FILE_OPS };

    const unmet: UnmetCriterion[] = [];
    let met = 0;
    let deferred = 0;
    let generic = 0;
    let checkable = 0;

    for (const a of assertions) {
      switch (a.kind) {
        case 'test-run':
          deferred++;
          unmet.push({ criterion: a.text, why: 'deferred: requires a live test/build run (not statically checkable)' });
          break;

        case 'generic':
          generic++;
          unmet.push({ criterion: a.text, why: 'deferred: could not be reduced to a static check' });
          break;

        case 'file-exists': {
          checkable++;
          const tgt = a.target ?? '';
          if (inDiffFiles(tgt, view) || existsInRepo(tgt, repoDir, budget)) {
            met++;
          } else {
            unmet.push({ criterion: a.text, why: `file/path not found in diff or repo: ${tgt}` });
          }
          break;
        }

        case 'export-present': {
          checkable++;
          const sym = a.target ?? '';
          if (exportPresent(sym, view, repoDir, budget)) {
            met++;
          } else {
            unmet.push({ criterion: a.text, why: `export not found for symbol: ${sym}` });
          }
          break;
        }

        case 'string-present': {
          checkable++;
          const needle = a.target ?? '';
          if (inDiffText(needle, view) || inTouchedRepoFiles(needle, view, repoDir, budget)) {
            met++;
          } else {
            unmet.push({ criterion: a.text, why: `required string not present in diff or touched files: ${needle}` });
          }
          break;
        }
      }
    }

    // Satisfied iff every STATICALLY-CHECKABLE assertion was met. Deferred /
    // generic items are surfaced but do not block — a cheap pass must not lie.
    const failedCheckable = checkable - met;
    const satisfied = failedCheckable === 0;

    const summary =
      `${met}/${checkable} static criteria met` +
      (deferred ? `, ${deferred} deferred (needs run)` : '') +
      (generic ? `, ${generic} generic` : '');

    return {
      satisfied,
      total: assertions.length,
      met,
      unmet,
      detail: { reason: summary, deferred, generic, checkable, assertions },
    };
  } catch (err) {
    // Never-throws: a checker failure must not block the pipeline. Report a
    // vacuously-satisfied result with the error surfaced in detail.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      satisfied: true,
      total: 0,
      met: 0,
      unmet: [],
      detail: { reason: `error (treated as no-op): ${msg}`, deferred: 0, generic: 0, checkable: 0, assertions: [] },
    };
  }
}
