/**
 * diff-safety.ts — M158: destructive-diff pre-judge guard.
 *
 * Pure, never-throws. Detects clearly-destructive patterns in a unified diff
 * BEFORE the proposal reaches the pending queue or frontier judge.
 *
 * Detected patterns:
 *  1. Wholesale file gutting (>60% of lines removed, or >80 net deletions) without
 *     comparable additions — handles delete-all / wholesale replacement.
 *  2. package.json dep destruction — diff removes ≥3 keys from a
 *     "dependencies" or "devDependencies" block, or drops the whole block.
 *  3. JSON breakage — duplicate keys introduced in a .json file's additions,
 *     or the resultant +lines form invalid JSON for a .json target.
 *  4. Deletion of whole critical files (package.json, package-lock.json,
 *     yarn.lock, pnpm-lock.yaml, tsconfig*.json) in a non-delete task.
 *
 * Conservative: a normal small edit, a 1-line version bump, an additive change,
 * or a legitimate file rename must NOT trip any heuristic (low false-positive).
 */

export interface DiffSafetyResult {
  destructive: boolean;
  reason?: string;
}

export interface DiffSafetyOptions {
  /** Max net-deletion ratio before "wholesale gutting" fires (default 0.60). */
  maxNetDeletionRatio?: number;
  /** Absolute net-deletion count floor below which ratio check is skipped (default 20). */
  minNetDeletionsForRatioCheck?: number;
  /** Absolute hard cap on net deletions regardless of ratio (default 80). */
  maxAbsoluteNetDeletions?: number;
  /** Min dep keys removed from a dependencies block to flag (default 3). */
  minDepsRemoved?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse out per-file hunks from a unified diff. Returns map of filename → lines. */
function parseFileDiffs(diff: string): Map<string, { added: string[]; removed: string[] }> {
  const result = new Map<string, { added: string[]; removed: string[] }>();
  if (!diff || typeof diff !== 'string') return result;

  let currentFile: string | null = null;
  let added: string[] = [];
  let removed: string[] = [];

  for (const raw of diff.split('\n')) {
    // New file header: "--- a/path" or "+++ b/path"
    // We use "+++ b/..." to pick the target filename.
    if (raw.startsWith('+++ ')) {
      // flush previous
      if (currentFile !== null) {
        result.set(currentFile, { added, removed });
      }
      // strip b/ or /dev/null prefix
      const name = raw.slice(4).replace(/^[ab]\//, '').trim();
      currentFile = name === '/dev/null' ? null : name;
      added = [];
      removed = [];
      continue;
    }
    if (currentFile === null) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      added.push(raw.slice(1));
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      removed.push(raw.slice(1));
    }
  }
  if (currentFile !== null) {
    result.set(currentFile, { added, removed });
  }
  return result;
}

/** Count how many dep keys are removed from a dependencies block in a unified diff for one file. */
function countRemovedDepKeys(removed: string[]): number {
  // Look for lines like: -    "some-package": "^1.2.3",
  const depLineRe = /^\s*"([@\w][\w./-]*)"\s*:/;
  let inDepsBlock = false;
  let count = 0;

  // We reconstruct the removed-line context to detect we're in a deps block.
  // Strategy: scan through removed lines; if a removed line looks like a dep key,
  // check that we've seen a "dependencies" or "devDependencies" anchor nearby.
  // Anchor: any removed line containing "dependencies": {
  const depsBlockRe = /"(?:dev|peer|optional)?[Dd]ependencies"\s*:\s*\{/;

  for (const line of removed) {
    if (depsBlockRe.test(line)) {
      inDepsBlock = true;
      continue;
    }
    if (inDepsBlock) {
      if (line.trim() === '}' || line.trim() === '},') {
        inDepsBlock = false;
        continue;
      }
      if (depLineRe.test(line)) {
        count++;
      }
    }
  }
  return count;
}

/** Detect if removal of the whole dependencies block is present (e.g. "dependencies": { … } gone). */
function removedEntireDepsBlock(removed: string[]): boolean {
  const hasAnchor = removed.some((l) =>
    /"(?:dev|peer|optional)?[Dd]ependencies"\s*:\s*\{/.test(l),
  );
  if (!hasAnchor) return false;
  // Added lines should NOT re-introduce a dependencies anchor
  return true;
}

/** Check for duplicate JSON keys in a list of lines (added content). */
function hasDuplicateJsonKeys(lines: string[]): boolean {
  // Only scan the property key lines
  const keyRe = /^\s*"([^"\\]*)"\s*:/;
  const seen = new Set<string>();
  for (const line of lines) {
    const m = line.match(keyRe);
    if (m) {
      const key = m[1];
      if (seen.has(key)) return true;
      seen.add(key);
    }
  }
  return false;
}

/** Check if combining existing (non-removed) lines + added lines would be valid JSON. */
function addedLinesAreInvalidJson(added: string[]): boolean {
  // Only check if the added lines alone look like a complete JSON object/array
  const joined = added.join('\n').trim();
  if (!joined.startsWith('{') && !joined.startsWith('[')) return false;
  if (!joined.endsWith('}') && !joined.endsWith(']')) return false;
  try {
    JSON.parse(joined);
    return false;
  } catch {
    return true;
  }
}

/** Filenames of critical files whose deletion is never expected in a normal patch. */
const CRITICAL_FILES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
]);
const CRITICAL_GLOB_RE = /^tsconfig[\w.-]*\.json$/;

function isCriticalFile(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  return CRITICAL_FILES.has(base) || CRITICAL_GLOB_RE.test(base);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * isDestructiveDiff — pure, never-throws pre-judge destructive-diff guard.
 *
 * Returns `{ destructive: true, reason }` when the diff matches a clearly-
 * destructive pattern. Returns `{ destructive: false }` for normal edits.
 */
export function isDestructiveDiff(
  diff: string | undefined | null,
  opts?: DiffSafetyOptions,
): DiffSafetyResult {
  try {
    if (!diff || typeof diff !== 'string' || diff.trim().length === 0) {
      return { destructive: false };
    }

    const maxNetDeletionRatio = opts?.maxNetDeletionRatio ?? 0.60;
    const minNetDeletionsForRatioCheck = opts?.minNetDeletionsForRatioCheck ?? 20;
    const maxAbsoluteNetDeletions = opts?.maxAbsoluteNetDeletions ?? 80;
    const minDepsRemoved = opts?.minDepsRemoved ?? 3;

    const fileDiffs = parseFileDiffs(diff);

    for (const [filename, { added, removed }] of fileDiffs) {
      const netDeletions = removed.length - added.length;

      // ── Rule 1: Wholesale gutting ────────────────────────────────────────
      // Hard absolute cap: >80 net deletions with no comparable additions
      if (
        netDeletions > maxAbsoluteNetDeletions &&
        added.length < removed.length * 0.4
      ) {
        return {
          destructive: true,
          reason: `wholesale file gutting in ${filename}: ${removed.length} lines removed, ${added.length} added (net -${netDeletions})`,
        };
      }

      // Ratio check: >60% net deletion ratio when there are enough lines to matter
      if (
        removed.length >= minNetDeletionsForRatioCheck &&
        netDeletions > 0 &&
        netDeletions / removed.length > maxNetDeletionRatio &&
        added.length < removed.length * 0.4
      ) {
        return {
          destructive: true,
          reason: `wholesale file gutting in ${filename}: ${removed.length} lines removed, ${added.length} added (${Math.round((netDeletions / removed.length) * 100)}% net deletion)`,
        };
      }

      // ── Rule 2: package.json dep destruction ────────────────────────────
      if (filename === 'package.json' || filename.endsWith('/package.json')) {
        const removedDeps = countRemovedDepKeys(removed);
        if (removedDeps >= minDepsRemoved) {
          return {
            destructive: true,
            reason: `package.json dep destruction: ${removedDeps} dependency keys removed`,
          };
        }
        // Whole block gone
        if (removed.length > 0 && added.length === 0 && removedEntireDepsBlock(removed)) {
          return {
            destructive: true,
            reason: `package.json dep destruction: entire dependencies block removed`,
          };
        }
      }

      // ── Rule 3: JSON breakage ────────────────────────────────────────────
      if (filename.endsWith('.json')) {
        if (hasDuplicateJsonKeys(added)) {
          return {
            destructive: true,
            reason: `JSON key collision in ${filename}: duplicate keys introduced in diff additions`,
          };
        }
        // Only flag invalid-JSON when the added lines look like they form a
        // complete JSON object (i.e. it's a wholesale replacement scenario)
        if (added.length > 10 && addedLinesAreInvalidJson(added)) {
          return {
            destructive: true,
            reason: `JSON breakage in ${filename}: added lines form invalid JSON`,
          };
        }
      }

      // ── Rule 4: Critical file deletion ──────────────────────────────────
      // Deletion: all lines removed, nothing (or nearly nothing) added
      if (isCriticalFile(filename) && removed.length > 0 && added.length === 0) {
        return {
          destructive: true,
          reason: `critical file deletion: ${filename} entirely removed`,
        };
      }
    }

    return { destructive: false };
  } catch {
    // Never-throws guarantee
    return { destructive: false };
  }
}
