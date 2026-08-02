const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_LINES = 250_000;
const MAX_DIFF_FILES = 10_000;

export type AutoMergeDiffScopeInvalidReason =
  | 'empty-diff'
  | 'diff-capacity-exceeded'
  | 'malformed-diff-header'
  | 'malformed-file-header'
  | 'file-header-mismatch'
  | 'duplicate-file-section'
  | 'incomplete-rename'
  | 'missing-file-header'
  | 'missing-hunk'
  | 'malformed-hunk-header'
  | 'malformed-hunk-body'
  | 'hunk-count-mismatch'
  | 'unsupported-file-mode'
  | 'binary-patch-unsupported';

type GitPatchMode = '100644' | '100755' | '120000' | '160000';

export interface AutoMergeDiffScopeFile {
  oldPath: string | null;
  newPath: string | null;
  renamed: boolean;
  additions: number;
  deletions: number;
}

export type AutoMergeDiffScopeResult =
  | {
      ok: true;
      files: number;
      changedLines: number;
      additions: number;
      deletions: number;
      touchedPaths: string[];
      entries: AutoMergeDiffScopeFile[];
    }
  | { ok: false; reason: AutoMergeDiffScopeInvalidReason };

export type AutoMergeDiffScopeGateResult =
  | { ok: true; files: number; lines: number; touchedPaths: string[] }
  | { ok: false; reason: AutoMergeDiffScopeInvalidReason };

interface FileSection {
  gitOldPath: string;
  gitNewPath: string;
  oldPath?: string | null;
  newPath?: string | null;
  renameFrom?: string;
  renameTo?: string;
  declaredKind?: 'added' | 'deleted' | 'mode';
  declaredMode?: GitPatchMode;
  oldMode?: GitPatchMode;
  newMode?: GitPatchMode;
  indexMode?: GitPatchMode;
  indexSeen: boolean;
  oldModeSeen: boolean;
  newModeSeen: boolean;
  additions: number;
  deletions: number;
  hunks: number;
}

interface HunkState {
  expectedOld: number;
  expectedNew: number;
  observedOld: number;
  observedNew: number;
  markerAllowed: boolean;
}

function parseQuotedToken(source: string, start: number): { value: string; end: number } | null {
  if (source[start] !== '"') {
    const end = source.indexOf(' ', start);
    const stop = end < 0 ? source.length : end;
    const value = source.slice(start, stop);
    return value ? { value, end: stop } : null;
  }
  let escaped = false;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    try {
      const value = JSON.parse(source.slice(start, index + 1)) as unknown;
      return typeof value === 'string' ? { value, end: index + 1 } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseGitHeader(line: string): { oldPath: string; newPath: string } | null {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return null;
  const source = line.slice(prefix.length);
  const oldToken = parseQuotedToken(source, 0);
  if (!oldToken || source[oldToken.end] !== ' ') return null;
  const newToken = parseQuotedToken(source, oldToken.end + 1);
  if (!newToken || newToken.end !== source.length) return null;
  if (!oldToken.value.startsWith('a/') || !newToken.value.startsWith('b/')) return null;
  const oldPath = normalizePath(oldToken.value);
  const newPath = normalizePath(newToken.value);
  return oldPath && newPath ? { oldPath, newPath } : null;
}

function parseHeaderPath(raw: string): string | null | undefined {
  const source = raw.trimEnd();
  if (!source) return undefined;
  let token: string;
  if (source.startsWith('"')) {
    const parsed = parseQuotedToken(source, 0);
    if (!parsed || (parsed.end !== source.length && source[parsed.end] !== '\t')) return undefined;
    token = parsed.value;
  } else {
    token = source.split('\t', 1)[0]!;
  }
  if (token === '/dev/null') return null;
  return normalizePath(token);
}

function normalizePath(raw: string): string | undefined {
  let value = raw;
  if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
  if (!value || value.includes('\0') || value.startsWith('/') || value.endsWith('/')) return undefined;
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) return undefined;
  return value;
}

function parseHunkHeader(line: string): HunkState | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) return null;
  if (oldStart < 0 || oldCount < 0 || newStart < 0 || newCount < 0) return null;
  return {
    expectedOld: oldCount,
    expectedNew: newCount,
    observedOld: 0,
    observedNew: 0,
    markerAllowed: false,
  };
}

function hunkComplete(hunk: HunkState): boolean {
  return hunk.observedOld === hunk.expectedOld && hunk.observedNew === hunk.expectedNew;
}

function parseGitModeMetadata(line: string, prefix: string): GitPatchMode | null {
  const match = line.match(new RegExp(`^${prefix} (100644|100755|120000|160000)$`));
  return (match?.[1] as GitPatchMode | undefined) ?? null;
}

function unsupportedGitMode(mode: GitPatchMode): boolean {
  return mode === '120000' || mode === '160000';
}

/**
 * Parse one canonical git unified diff and return its mutation scope. A changed
 * line is one added or deleted hunk body line; context and metadata never count.
 * Any ambiguous structure is rejected so every authority consumer fails closed.
 */
export function measureAutoMergeDiffScope(diff: string | null | undefined): AutoMergeDiffScopeResult {
  if (typeof diff !== 'string' || !diff.trim()) return { ok: false, reason: 'empty-diff' };
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
    return { ok: false, reason: 'diff-capacity-exceeded' };
  }
  const lines = diff.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines.length > MAX_DIFF_LINES) return { ok: false, reason: 'diff-capacity-exceeded' };

  const entries: AutoMergeDiffScopeFile[] = [];
  const seenPaths = new Set<string>();
  let section: FileSection | null = null;
  let hunk: HunkState | null = null;

  const finishHunk = (): AutoMergeDiffScopeInvalidReason | null => {
    if (!hunk) return null;
    if (!hunkComplete(hunk)) return 'hunk-count-mismatch';
    hunk = null;
    return null;
  };

  const finishSection = (): AutoMergeDiffScopeInvalidReason | null => {
    const hunkError = finishHunk();
    if (hunkError) return hunkError;
    if (!section) return null;
    const renamed = section.renameFrom !== undefined || section.renameTo !== undefined;
    if (renamed && (section.renameFrom === undefined || section.renameTo === undefined)) {
      return 'incomplete-rename';
    }
    if (renamed && section.declaredKind !== undefined) return 'malformed-file-header';
    if (section.oldModeSeen !== section.newModeSeen) return 'malformed-file-header';
    if (section.declaredKind === 'mode' &&
      (section.oldMode === undefined || section.newMode === undefined ||
        section.oldMode === section.newMode || section.indexMode !== undefined)) {
      return 'malformed-file-header';
    }
    if (section.declaredMode !== undefined && section.indexMode !== undefined &&
      section.declaredMode !== section.indexMode) {
      return 'malformed-file-header';
    }
    let headerOldPath = section.oldPath;
    let headerNewPath = section.newPath;
    if (headerOldPath === undefined && headerNewPath === undefined && !renamed) {
      if (section.declaredKind === 'added') {
        headerOldPath = null;
        headerNewPath = section.gitNewPath;
      } else if (section.declaredKind === 'deleted') {
        headerOldPath = section.gitOldPath;
        headerNewPath = null;
      } else if (section.declaredKind === 'mode' && section.oldModeSeen && section.newModeSeen) {
        headerOldPath = section.gitOldPath;
        headerNewPath = section.gitNewPath;
      } else {
        return 'missing-file-header';
      }
    } else if ((headerOldPath === undefined || headerNewPath === undefined) && !renamed) {
      return 'missing-file-header';
    }
    if (renamed && section.hunks > 0 &&
      (section.oldPath === undefined || section.newPath === undefined)) {
      return 'missing-file-header';
    }
    const oldPath = renamed ? section.renameFrom! : headerOldPath!;
    const newPath = renamed ? section.renameTo! : headerNewPath!;
    if (renamed && headerOldPath !== undefined && headerOldPath !== oldPath) {
      return 'file-header-mismatch';
    }
    if (renamed && headerNewPath !== undefined && headerNewPath !== newPath) {
      return 'file-header-mismatch';
    }
    if (section.declaredKind === 'added' && (oldPath !== null || newPath === null)) {
      return 'file-header-mismatch';
    }
    if (section.declaredKind === 'deleted' && (oldPath === null || newPath !== null)) {
      return 'file-header-mismatch';
    }
    if (oldPath === null && newPath === null) return 'malformed-file-header';
    if (oldPath !== null && oldPath !== section.gitOldPath) return 'file-header-mismatch';
    if (newPath !== null && newPath !== section.gitNewPath) return 'file-header-mismatch';
    if (section.hunks === 0 && !renamed && section.declaredKind === undefined) return 'missing-hunk';
    for (const path of [oldPath, newPath]) {
      if (path === null) continue;
      if (seenPaths.has(path)) return 'duplicate-file-section';
    }
    if (oldPath !== null) seenPaths.add(oldPath);
    if (newPath !== null) seenPaths.add(newPath);
    entries.push({
      oldPath,
      newPath,
      renamed,
      additions: section.additions,
      deletions: section.deletions,
    });
    section = null;
    return entries.length > MAX_DIFF_FILES ? 'diff-capacity-exceeded' : null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const sectionError = finishSection();
      if (sectionError) return { ok: false, reason: sectionError };
      const header = parseGitHeader(line);
      if (!header) return { ok: false, reason: 'malformed-diff-header' };
      section = {
        gitOldPath: header.oldPath,
        gitNewPath: header.newPath,
        additions: 0,
        deletions: 0,
        hunks: 0,
        indexSeen: false,
        oldModeSeen: false,
        newModeSeen: false,
      };
      continue;
    }
    if (!section) {
      if (line === '') continue;
      return { ok: false, reason: 'malformed-diff-header' };
    }

    if (hunk && line === '\\ No newline at end of file') {
      if (!hunk.markerAllowed) return { ok: false, reason: 'malformed-hunk-body' };
      hunk.markerAllowed = false;
      continue;
    }
    if (hunk && hunkComplete(hunk)) hunk = null;
    if (hunk) {
      const prefix = line[0];
      if (prefix === ' ') {
        hunk.observedOld++;
        hunk.observedNew++;
      } else if (prefix === '+') {
        hunk.observedNew++;
        section.additions++;
      } else if (prefix === '-') {
        hunk.observedOld++;
        section.deletions++;
      } else {
        return { ok: false, reason: 'malformed-hunk-body' };
      }
      hunk.markerAllowed = prefix === '+' || prefix === '-';
      if (hunk.observedOld > hunk.expectedOld || hunk.observedNew > hunk.expectedNew) {
        return { ok: false, reason: 'hunk-count-mismatch' };
      }
      continue;
    }

    if (line.startsWith('@@')) {
      if (section.oldPath === undefined || section.newPath === undefined) {
        return { ok: false, reason: 'missing-file-header' };
      }
      const parsed = parseHunkHeader(line);
      if (!parsed) return { ok: false, reason: 'malformed-hunk-header' };
      hunk = parsed;
      section.hunks++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (section.oldPath !== undefined || section.newPath !== undefined || section.hunks > 0) {
        return { ok: false, reason: 'malformed-file-header' };
      }
      const path = parseHeaderPath(line.slice(4));
      if (path === undefined) return { ok: false, reason: 'malformed-file-header' };
      section.oldPath = path;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (section.oldPath === undefined || section.newPath !== undefined || section.hunks > 0) {
        return { ok: false, reason: 'malformed-file-header' };
      }
      const path = parseHeaderPath(line.slice(4));
      if (path === undefined) return { ok: false, reason: 'malformed-file-header' };
      section.newPath = path;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (section.renameTo !== undefined || section.oldPath !== undefined || section.hunks > 0) {
        return { ok: false, reason: 'incomplete-rename' };
      }
      const path = parseHeaderPath(line.slice('rename from '.length));
      if (!path || section.renameFrom !== undefined) return { ok: false, reason: 'incomplete-rename' };
      section.renameFrom = path;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (section.renameFrom === undefined || section.oldPath !== undefined || section.hunks > 0) {
        return { ok: false, reason: 'incomplete-rename' };
      }
      const path = parseHeaderPath(line.slice('rename to '.length));
      if (!path || section.renameTo !== undefined) return { ok: false, reason: 'incomplete-rename' };
      section.renameTo = path;
      continue;
    }
    if (line.startsWith('new file mode ')) {
      const mode = parseGitModeMetadata(line, 'new file mode');
      if (!mode || section.declaredKind !== undefined ||
        section.oldPath !== undefined || section.hunks > 0) {
        return { ok: false, reason: 'malformed-file-header' };
      }
      if (unsupportedGitMode(mode)) return { ok: false, reason: 'unsupported-file-mode' };
      section.declaredKind = 'added';
      section.declaredMode = mode;
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      const mode = parseGitModeMetadata(line, 'deleted file mode');
      if (!mode || section.declaredKind !== undefined ||
        section.oldPath !== undefined || section.hunks > 0) {
        return { ok: false, reason: 'malformed-file-header' };
      }
      if (unsupportedGitMode(mode)) return { ok: false, reason: 'unsupported-file-mode' };
      section.declaredKind = 'deleted';
      section.declaredMode = mode;
      continue;
    }
    if (line.startsWith('old mode ')) {
      const mode = parseGitModeMetadata(line, 'old mode');
      if (!mode || section.declaredKind !== undefined ||
        section.oldPath !== undefined || section.hunks > 0) {
        return { ok: false, reason: 'malformed-file-header' };
      }
      if (unsupportedGitMode(mode)) return { ok: false, reason: 'unsupported-file-mode' };
      section.declaredKind = 'mode';
      section.oldMode = mode;
      section.oldModeSeen = true;
      continue;
    }
    if (line.startsWith('new mode ')) {
      const mode = parseGitModeMetadata(line, 'new mode');
      if (!mode || section.declaredKind !== 'mode' ||
        !section.oldModeSeen || section.newModeSeen ||
        section.oldPath !== undefined || section.hunks > 0) {
        return { ok: false, reason: 'malformed-file-header' };
      }
      if (unsupportedGitMode(mode)) return { ok: false, reason: 'unsupported-file-mode' };
      section.newMode = mode;
      section.newModeSeen = true;
      continue;
    }
    if (line.startsWith('index ')) {
      const match = line.match(
        /^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: (100644|100755|120000|160000))?$/,
      );
      if (!match || section.indexSeen || section.oldPath !== undefined || section.hunks > 0) {
        return { ok: false, reason: 'malformed-file-header' };
      }
      const mode = match[1] as GitPatchMode | undefined;
      if (mode && unsupportedGitMode(mode)) {
        return { ok: false, reason: 'unsupported-file-mode' };
      }
      section.indexSeen = true;
      section.indexMode = mode;
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      return { ok: false, reason: 'binary-patch-unsupported' };
    }
    if (line === '' || /^(?:similarity index|dissimilarity index) /.test(line)) {
      continue;
    }
    return { ok: false, reason: 'malformed-file-header' };
  }

  const finalError = finishSection();
  if (finalError) return { ok: false, reason: finalError };
  if (entries.length === 0) return { ok: false, reason: 'empty-diff' };
  const additions = entries.reduce((sum, entry) => sum + entry.additions, 0);
  const deletions = entries.reduce((sum, entry) => sum + entry.deletions, 0);
  return {
    ok: true,
    files: entries.length,
    changedLines: additions + deletions,
    additions,
    deletions,
    touchedPaths: [...seenPaths].sort(),
    entries,
  };
}

/** Authority-facing projection of the sole canonical parser result. */
export function measureAutoMergeDiffScopeForGate(
  diff: string | null | undefined,
): AutoMergeDiffScopeGateResult {
  const scope = measureAutoMergeDiffScope(diff);
  return scope.ok
    ? { ok: true, files: scope.files, lines: scope.changedLines, touchedPaths: scope.touchedPaths }
    : scope;
}
