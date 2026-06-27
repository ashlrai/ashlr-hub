/**
 * portfolio/scanners.ts — Work-discovery scanners for `ashlr backlog`.
 *
 * GUARDRAILS (enforced throughout this file):
 *  - READ-ONLY: no file writes, no git mutations, no installs, no fixes,
 *    no `npm test`/`npm run build`.
 *  - No shell: all child-process invocations use execFile with arg arrays
 *    (no shell:true, no string interpolation of repo paths into a shell string).
 *  - Bounded: skip node_modules/.git/dist/build; cap output/files/time.
 *  - Never throws: every scanner returns [] on any error/timeout/missing-tool.
 *  - Enrollment-scoped: callers (buildBacklog) only pass listEnrolled() paths.
 *  - No secrets in any emitted WorkItem.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

import type { WorkItem, WorkSource, AshlrConfig } from '../types.js';
import { listIssues, githubStatus } from '../integrations/github.js';
import { isTrivialItem, isNonCodePath } from './value-filter.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCAN_TIMEOUT_MS = 15_000;
const NPM_TIMEOUT_MS = 20_000;
const MAX_TODO_HITS = 200;
const MAX_OUTDATED_ITEMS = 50;
const MAX_VULN_ITEMS = 20;

// ---------------------------------------------------------------------------
// Shared ignore predicate — non-actionable / generated / vendored files
// ---------------------------------------------------------------------------

/**
 * Directory names that are NEVER actionable (generated, vendored, tooling).
 * Used as a fast segment-check on file paths from rg/grep output.
 *
 * M136: extended with vendored/third-party/benchmark/reference directories.
 * These are not first-party source — scanning them for TODO markers produces
 * only noise (85%+ of all fleet proposals were coming from these paths).
 */
const IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'target',
  '.vscode',
  '.git',
  'vendor',
  '.turbo',
  // M136: vendored / third-party / benchmark / reference dirs
  'bench',
  'benchmark',
  'benchmarks',
  'refs',
  'third_party',
  'third-party',
  'vendor',
  'vendors',
  'examples',
  'fixtures',
  '__pycache__',
  '.venv',
  'site-packages',
  'migrations',
  'pandas',
]);

/**
 * File name patterns that identify non-actionable generated/lock/minified files.
 * A TODO inside any of these is not a real work item.
 *
 * M136: also matches vendored-language-library path suffixes (e.g. *-lib/,
 * python-lib/, site-packages/) that appear as directory segments.
 */
const IGNORE_FILE_RE =
  /(?:^|[\/])(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.min\.[cm]?[jt]sx?$|\.min\.css$|\.generated\.[^.]+$|\.map$/i;

/**
 * M136: Path pattern for vendored language-library directories that appear as
 * path segments but are not caught by exact IGNORE_DIRS set membership.
 * Matches:  *-lib/  *_lib/  python-lib/  any-lib/  site-packages/
 */
const IGNORE_VENDORED_PATH_RE = /(?:^|\/)(?:[a-z0-9_-]+-lib|site-packages)\//i;

/**
 * Returns true when the given file path (rg/grep output style, relative or
 * absolute) should be IGNORED by all file-walking scanners.
 *
 * Rules:
 *  1. Any path segment matching IGNORE_DIRS (e.g. node_modules, dist, .git).
 *  2. Any file name matching IGNORE_FILE_RE (lockfiles, *.min.js, *.map, etc.).
 */
export function isIgnoredPath(filePath: string): boolean {
  // Normalise separators so we can reliably split on '/'
  const normalised = filePath.replace(/\\/g, '/');
  const segments = normalised.split('/');
  for (const seg of segments) {
    if (seg && IGNORE_DIRS.has(seg)) return true;
  }
  if (IGNORE_FILE_RE.test(normalised)) return true;
  // M136: vendored language-library paths (e.g. python-lib/, *-lib/, site-packages/)
  if (IGNORE_VENDORED_PATH_RE.test(normalised)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic stable id for a WorkItem.
 * Format: `<repoBasename>:<source>:<hash(discriminator)>`
 */
function makeId(repo: string, source: WorkSource, discriminator: string): string {
  const hash = createHash('sha1')
    .update(repo + ':' + discriminator)
    .digest('hex')
    .slice(0, 10);
  return `${basename(repo)}:${source}:${hash}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Clamp a number to the 1..5 range.
 */
function clamp(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)));
}

/**
 * Import scoreItem lazily to avoid a circular dep if backlog.ts imports us.
 * We inline the same pure formula here so scanners.ts is self-contained.
 * Must match backlog.ts#scoreItem exactly: value / max(1, effort), clamped.
 */
function score(value: number, effort: number): number {
  const v = clamp(value);
  const e = Math.max(1, clamp(effort));
  return Math.round((v / e) * 100) / 100;
}

function makeItem(
  repo: string,
  source: WorkSource,
  discriminator: string,
  title: string,
  detail: string,
  value: number,
  effort: number,
  tags: string[],
): WorkItem {
  const v = clamp(value);
  const e = clamp(effort);
  return {
    id: makeId(repo, source, discriminator),
    repo,
    source,
    title,
    detail,
    value: v,
    effort: e,
    score: score(v, e),
    tags,
    ts: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// scanIssues — open GitHub issues via M18 listIssues
//
// M95 actionability rules:
//  - EPIC/META/LARGE issues: titles that signal an epic, umbrella, or
//    tracking issue (keywords: epic, tracking, umbrella, meta, roadmap,
//    milestone, initiative, overhaul, refactor, rewrite, support, implement,
//    add support for) are scoped to a concrete "investigate and implement the
//    smallest fix" first-step item rather than handed as-is.
//  - ALL items: summary/detail is a concrete, scoped instruction — not just
//    a URL. The engine receives file/area guidance and a definition of "done".
// ---------------------------------------------------------------------------

/** Keywords in an issue title that signal an epic/umbrella/large item. */
const EPIC_TITLE_RE =
  /\b(epic|tracking|umbrella|meta|roadmap|milestone|initiative|overhaul|refactor|rewrite|support for|add support|windows support|linux support|implement|port to)\b/i;

/**
 * True when the issue title looks like an epic/meta/large item that a single
 * diff cannot address. These are scoped rather than dropped.
 */
function isEpicIssue(title: string): boolean {
  return EPIC_TITLE_RE.test(title);
}

export async function scanIssues(repo: string): Promise<WorkItem[]> {
  try {
    const issues = listIssues(repo);
    if (!Array.isArray(issues) || issues.length === 0) return [];

    const items: WorkItem[] = [];
    const repoName = basename(repo);

    for (const issue of issues) {
      const epic = isEpicIssue(issue.title);

      if (epic) {
        // Reframe as a scoped first-step: investigate and implement the
        // smallest concrete fix. The engine gets a bounded, actionable scope.
        items.push(
          makeItem(
            repo,
            'issue',
            `issue:${issue.number}`,
            `Investigate issue #${issue.number} and implement the smallest concrete fix`,
            `Issue #${issue.number} in ${repoName} ("${issue.title}") is a large or epic item. ` +
              `Do NOT attempt to implement it in full. Instead: (1) read the issue at ${issue.url}, ` +
              `(2) identify the single smallest self-contained sub-problem, ` +
              `(3) implement only that sub-problem as a focused diff in one or two files. ` +
              `Stop after the smallest concrete change that adds value. ` +
              `Leave the broader issue open for future ticks.`,
            2, // lower value — scoped investigation, not a full fix
            2,
            ['issue', `#${issue.number}`, 'scoped', 'epic'],
          ),
        );
      } else {
        // Concrete, bounded issue: include scoped instruction in detail.
        items.push(
          makeItem(
            repo,
            'issue',
            `issue:${issue.number}`,
            `Fix issue #${issue.number}: ${issue.title}`,
            `Issue #${issue.number} in ${repoName}: "${issue.title}". ` +
              `Read the full issue at ${issue.url}, then implement a focused fix ` +
              `in the relevant file(s). The change should be self-contained and ` +
              `not touch unrelated code. Confirm the fix resolves the reported behaviour.`,
            3,
            2,
            ['issue', `#${issue.number}`],
          ),
        );
      }
    }

    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// M136: First-party source path predicate
// ---------------------------------------------------------------------------

/**
 * Returns true when the given file path is under a recognised first-party
 * source directory: src/, lib/, app/, or packages/<name>/src/.
 *
 * Only used by scanTodos (when enabled) to ensure markers in config files,
 * root scripts, tooling, and other non-product code are never emitted.
 */
export function isFirstPartySourcePath(filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  // Fast path: relative path starting with a first-party root.
  if (
    normalised.startsWith('src/') ||
    normalised.startsWith('lib/') ||
    normalised.startsWith('app/') ||
    /^packages\/[^/]+\/src\//.test(normalised)
  ) {
    return true;
  }
  // Absolute paths (e.g. from tests or rg with full paths): check for a
  // first-party segment anywhere in the path. This handles the case where
  // rg is invoked with an absolute cwd and returns absolute paths.
  // We look for /src/, /lib/, /app/, or /packages/<name>/src/ as segments.
  return (
    /\/src\//.test(normalised) ||
    /\/lib\//.test(normalised) ||
    /\/app\//.test(normalised) ||
    /\/packages\/[^/]+\/src\//.test(normalised)
  );
}

// ---------------------------------------------------------------------------
// scanTodos — TODO/FIXME/HACK/XXX comments via rg/grep
// ---------------------------------------------------------------------------

/**
 * Run rg if available, else grep. Returns raw stdout or null.
 * Uses execFile (no shell). Excludes node_modules/.git/dist/build.
 * Caps at MAX_TODO_HITS lines.
 */
async function rgOrGrep(repo: string): Promise<string | null> {
  // Try ripgrep first (faster, respects .gitignore)
  try {
    const { stdout } = await execFileAsync(
      'rg',
      [
        '--line-number',
        '--no-heading',
        '--glob', '!node_modules',
        '--glob', '!.git',
        '--glob', '!dist',
        '--glob', '!build',
        '--glob', '!out',
        '--glob', '!coverage',
        '--glob', '!.next',
        '--glob', '!target',
        '--glob', '!.vscode',
        '--glob', '!vendor',
        '--glob', '!vendors',
        '--glob', '!.turbo',
        // M136: vendored/third-party/benchmark/reference dirs
        '--glob', '!bench',
        '--glob', '!benchmark',
        '--glob', '!benchmarks',
        '--glob', '!refs',
        '--glob', '!third_party',
        '--glob', '!third-party',
        '--glob', '!examples',
        '--glob', '!fixtures',
        '--glob', '!__pycache__',
        '--glob', '!.venv',
        '--glob', '!migrations',
        '--glob', '!pandas',
        '--glob', '!*-lib',
        '--glob', '!*.lock',
        '--glob', '!*.min.js',
        '--glob', '!*.min.css',
        '--glob', '!*.map',
        '--max-count', String(MAX_TODO_HITS),
        '-e', 'TODO|FIXME|HACK|XXX',
        '.',
      ],
      {
        cwd: repo,
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1 MB cap
      },
    );
    return stdout ?? null;
  } catch (err: unknown) {
    // rg exits 1 when no matches — that's not a tool-missing error
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string };
    if (e?.stdout && typeof e.stdout === 'string') {
      // rg found matches but hit max-count or returned non-zero for other reason
      return e.stdout;
    }
    if (e?.code === '1') {
      // exit code 1 = no matches found
      return '';
    }
    // rg not available (ENOENT) — fall through to grep
  }

  // Fallback: GNU/BSD grep
  try {
    const { stdout } = await execFileAsync(
      'grep',
      [
        '-rn',
        '--include=*.ts',
        '--include=*.tsx',
        '--include=*.js',
        '--include=*.jsx',
        '--include=*.mjs',
        '--include=*.cjs',
        '--include=*.py',
        '--include=*.go',
        '--include=*.rb',
        '--include=*.java',
        '--include=*.cs',
        '--include=*.swift',
        '--include=*.rs',
        '--exclude-dir=node_modules',
        '--exclude-dir=.git',
        '--exclude-dir=dist',
        '--exclude-dir=build',
        '-m', String(MAX_TODO_HITS),
        '-E', 'TODO|FIXME|HACK|XXX',
        '.',
      ],
      {
        cwd: repo,
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
    return stdout ?? null;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string };
    if (e?.stdout && typeof e.stdout === 'string') return e.stdout;
    if (e?.code === '1') return ''; // no matches
    return null;
  }
}

/**
 * M136: scanTodos is DEFAULT OFF. Pass cfg with cfg.foundry.scanTodos = true
 * to enable. When disabled the fleet works substantive sources (issues, lint,
 * security, deps, self-improve, hygiene) instead of bare-marker noise.
 *
 * The SCANNERS array binds (repo) => scanTodos(repo, undefined) which means
 * cfg defaults to undefined → disabled. Callers that opt in pass cfg explicitly.
 */
export async function scanTodos(repo: string, cfg?: Pick<AshlrConfig, 'foundry'>): Promise<WorkItem[]> {
  // M136: gate — disabled by default; only run when explicitly opted in.
  if (!cfg?.foundry?.scanTodos) return [];

  try {
    const raw = await rgOrGrep(repo);
    if (!raw || raw.trim() === '') return [];

    const lines = raw.split('\n').filter(Boolean).slice(0, MAX_TODO_HITS);

    // Cluster by file: emit one WorkItem per file (to avoid flooding).
    // Track the first occurrence line number and the full comment text for each file.
    const byFile = new Map<string, { count: number; firstLine: string; lineNum: string; sample: string; tags: string[] }>();

    for (const line of lines) {
      // rg/grep -n output: "path/to/file:42:...comment..."
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const rest = line.slice(colonIdx + 1);
      const colonIdx2 = rest.indexOf(':');
      const filePath = line.slice(0, colonIdx);
      const lineNum = colonIdx2 >= 0 ? rest.slice(0, colonIdx2) : '';
      const commentText = colonIdx2 >= 0 ? rest.slice(colonIdx2 + 1).trim() : rest.trim();

      // Detect which marker type
      const tags: string[] = [];
      if (/TODO/i.test(commentText)) tags.push('todo');
      if (/FIXME/i.test(commentText)) tags.push('fixme');
      if (/HACK/i.test(commentText)) tags.push('hack');
      if (/XXX/i.test(commentText)) tags.push('xxx');

      // Skip TODOs in generated, vendored, or lock files
      if (isIgnoredPath(filePath)) continue;
      // M133: Skip TODOs in non-code files (docs, CHANGELOG, test files, .md, etc.)
      // These are down-valued to trivial at the item level; skip them here too so
      // they never accumulate into a byFile cluster that would emit a value=1 item
      // consuming a backlog slot.
      if (isNonCodePath(filePath)) continue;
      // M136: Only emit TODOs from first-party source directories.
      // Paths that don't begin with src/, lib/, app/, or packages/*/src are not
      // first-party source — they may be scripts, config, root files, or other
      // non-product code that produces noise without actionable diffs.
      if (!isFirstPartySourcePath(filePath)) continue;

      const existing = byFile.get(filePath);
      if (existing) {
        existing.count++;
        for (const t of tags) {
          if (!existing.tags.includes(t)) existing.tags.push(t);
        }
      } else {
        byFile.set(filePath, {
          count: 1,
          firstLine: line,
          lineNum,
          sample: commentText.slice(0, 200),
          tags,
        });
      }
    }

    const items: WorkItem[] = [];
    for (const [filePath, info] of byFile) {
      const plural = info.count > 1 ? `${info.count} markers` : '1 marker';
      const lineRef = info.lineNum ? `:${info.lineNum}` : '';
      // Detail is a concrete, scoped instruction: file + line + the TODO text + action
      const detail =
        `File: ${filePath}${lineRef} — "${info.sample.replace(/\n/g, ' ').slice(0, 160)}". ` +
        `Implement this specific change. Do not touch unrelated code. ` +
        `If this TODO is already resolved, remove the marker.`;

      // M124: assign value=1 to items flagged as trivial by isTrivialItem so
      // the buildBacklog min-value gate drops them without needing a second pass.
      // Substantive TODOs (with a real description) retain value=2.
      const candidate = makeItem(
        repo,
        'todo',
        `todo:${filePath}`,
        `${plural} in ${filePath}${lineRef}`,
        detail,
        2,
        2,
        ['todo', ...info.tags],
      );
      const { trivial } = isTrivialItem(candidate);
      if (trivial) {
        items.push({ ...candidate, value: 1, score: candidate.score / 2 });
      } else {
        items.push(candidate);
      }
    }

    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// scanTests — CI state + test-script heuristic (DO NOT run the test suite)
// ---------------------------------------------------------------------------

export async function scanTests(repo: string): Promise<WorkItem[]> {
  try {
    const items: WorkItem[] = [];

    // 1. Check package.json for a test script (heuristic, read-only)
    const pkgPath = join(repo, 'package.json');
    let hasTestScript = false;
    if (existsSync(pkgPath)) {
      try {
        const raw = readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw) as Record<string, unknown>;
        const scripts = pkg['scripts'];
        if (
          scripts !== null &&
          typeof scripts === 'object' &&
          !Array.isArray(scripts)
        ) {
          const s = scripts as Record<string, unknown>;
          if (typeof s['test'] === 'string' && s['test'].trim() !== '') {
            hasTestScript = true;
          }
        }
      } catch {
        // malformed package.json — treat as no test script
      }
    }

    if (!hasTestScript) {
      // Only emit "no tests" if there's a package.json at all (i.e. it's a Node project)
      if (existsSync(pkgPath)) {
        items.push(
          makeItem(
            repo,
            'test',
            'test:no-test-script',
            'No test script found in package.json',
            'package.json has no "test" script — consider adding a test suite.',
            3,
            3,
            ['test', 'no-tests'],
          ),
        );
      }
      // No point checking CI if there's no test script (might still have CI though)
    }

    // 2. Check CI state via M18 githubStatus (reads gh run list, never runs tests)
    const status = githubStatus(repo);
    if (status.isRepo && status.ci === 'failing') {
      items.push(
        makeItem(
          repo,
          'test',
          'test:ci-failing',
          'CI is failing',
          `GitHub Actions: latest run status is failing for ${status.repo ?? repo}`,
          // Low value: a red CI is an ALERT (surfaced in `ashlr fleet watch` /
          // Mission Control), NOT fleet-fixable work — the fleet can't patch it
          // without diagnosing the failure, so it only yields a no-diff note.
          // Rank it BELOW actionable code (TODOs/skipped tests/deps) so the fleet
          // spends ticks on items it can actually produce a diff for.
          2,
          2,
          ['test', 'ci', 'failing'],
        ),
      );
    }
    // NOTE: a 'pending' CI (a run merely in progress) is intentionally NOT a work
    // item — it's transient status noise, not a problem to act on.

    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// scanDeps — npm outdated + npm audit (metadata only, no installs)
// ---------------------------------------------------------------------------

/**
 * Run `npm outdated --json` in repo. Returns parsed JSON or null.
 * Bounded: timeout, never installs, --no-fund suppresses network noise.
 */
async function npmOutdated(repo: string): Promise<Record<string, unknown> | null> {
  try {
    // npm outdated exits 1 when there are outdated packages — capture stdout anyway
    const { stdout } = await execFileAsync(
      'npm',
      ['outdated', '--json', '--no-fund', '--ignore-scripts'],
      {
        cwd: repo,
        timeout: NPM_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
      },
    ).catch((err: unknown) => {
      // npm outdated exits non-zero when packages are outdated but still emits JSON stdout
      const e = err as { stdout?: string };
      if (e?.stdout) return { stdout: e.stdout };
      throw err;
    });

    if (!stdout || stdout.trim() === '') return null;
    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Run `npm audit --json` in repo. Returns parsed JSON or null.
 * Bounded: timeout, never installs.
 */
async function npmAudit(repo: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['audit', '--json', '--no-fund', '--ignore-scripts'],
      {
        cwd: repo,
        timeout: NPM_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
      },
    ).catch((err: unknown) => {
      // npm audit exits non-zero when vulnerabilities are found but still emits JSON
      const e = err as { stdout?: string };
      if (e?.stdout) return { stdout: e.stdout };
      throw err;
    });

    if (!stdout || stdout.trim() === '') return null;
    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns true when an npm audit advisory has a non-breaking fix the operator
 * can safely apply without a deliberate semver-major migration.
 *
 * npm audit v2 `fixAvailable` shape:
 *   false                        — no fix at all
 *   true                         — patch/minor fix available (actionable)
 *   { name, version, isSemVerMajor: boolean }
 *                                — fix exists but requires a major bump when
 *                                  isSemVerMajor===true (NOT actionable without
 *                                  a breaking-change migration decision)
 *
 * Exported so it can be unit-tested in isolation.
 */
export function isActionableFix(fixAvailable: unknown): boolean {
  if (fixAvailable === true) return true;
  if (fixAvailable === false || fixAvailable === null || fixAvailable === undefined) return false;
  if (typeof fixAvailable === 'object' && !Array.isArray(fixAvailable)) {
    const fa = fixAvailable as Record<string, unknown>;
    // isSemVerMajor:true means a breaking major bump is required — not actionable
    if (fa['isSemVerMajor'] === true) return false;
    // isSemVerMajor:false (or absent) means a non-breaking fix exists
    return true;
  }
  return false;
}

export async function scanDeps(repo: string): Promise<WorkItem[]> {
  try {
    const pkgPath = join(repo, 'package.json');
    if (!existsSync(pkgPath)) return [];

    const items: WorkItem[] = [];
    let count = 0;

    // 1. Outdated deps
    const outdated = await npmOutdated(repo);
    if (outdated) {
      for (const [pkg, info] of Object.entries(outdated)) {
        if (count >= MAX_OUTDATED_ITEMS) break;
        if (typeof info !== 'object' || info === null) continue;
        const dep = info as Record<string, unknown>;

        const current = typeof dep['current'] === 'string' ? dep['current'] : '?';
        const wanted = typeof dep['wanted'] === 'string' ? dep['wanted'] : '?';
        const latest = typeof dep['latest'] === 'string' ? dep['latest'] : '?';
        const type = typeof dep['type'] === 'string' ? dep['type'] : 'dependency';

        // Assess major version jump
            const currentMajorStr = current.split('.')[0];
    const latestMajorStr = latest.split('.')[0];
    const currentMajor = currentMajorStr !== undefined ? parseInt(currentMajorStr, 10) : NaN;
    const latestMajor = latestMajorStr !== undefined ? parseInt(latestMajorStr, 10) : NaN;
    const isMajorBump = !isNaN(currentMajor) && !isNaN(latestMajor) && latestMajor > currentMajor;

        const value = isMajorBump ? 3 : 2;
        const effort = isMajorBump ? 3 : 2;

        items.push(
          makeItem(
            repo,
            'dep',
            `dep:outdated:${pkg}`,
            `Outdated: ${pkg} (${current} → ${latest})`,
            `current: ${current}, wanted: ${wanted}, latest: ${latest}, type: ${type}`,
            value,
            effort,
            ['dep', 'outdated', isMajorBump ? 'major' : 'minor', type],
          ),
        );
        count++;
      }
    }

    // 2. Vulnerabilities from npm audit
    const audit = await npmAudit(repo);
    if (audit) {
      // npm audit --json v7+ shape: { vulnerabilities: { [name]: { severity, fixAvailable, ... } } }
      // Only count advisories that have an ACTIONABLE non-breaking fix available.
      // Skip fixAvailable:false (no fix exists) or fixAvailable:{isSemVerMajor:true}
      // (fix requires a breaking major bump the operator must deliberately choose).
      // Re-flagging unactionable vulns every daemon tick is pure noise.
      const vulnCounts: Record<string, number> = {};

      const vulns = audit['vulnerabilities'];
      if (vulns !== null && typeof vulns === 'object' && !Array.isArray(vulns)) {
        const entries = vulns as Record<string, unknown>;
        for (const entry of Object.values(entries)) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const e = entry as Record<string, unknown>;
          if (!isActionableFix(e['fixAvailable'])) continue;
          const sev = typeof e['severity'] === 'string' ? e['severity'] : 'unknown';
          vulnCounts[sev] = (vulnCounts[sev] ?? 0) + 1;
        }
      }

      // Emit one WorkItem per non-zero severity (actionable-only counts)
      const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];
      let vulnCount = 0;
      for (const sev of SEVERITY_ORDER) {
        if (vulnCount >= MAX_VULN_ITEMS) break;
        const n = typeof vulnCounts[sev] === 'number' ? vulnCounts[sev] : 0;
        if (n === 0) continue;

        const value = sev === 'critical' ? 5 : sev === 'high' ? 4 : sev === 'moderate' ? 3 : 2;
        const effort = 2;

        items.push(
          makeItem(
            repo,
            'dep',
            `dep:vuln:${sev}`,
            `${n} ${sev} npm vulnerabilit${n === 1 ? 'y' : 'ies'}`,
            `Run \`npm audit\` in ${basename(repo)} to see details. Severity: ${sev}.`,
            value,
            effort,
            ['dep', 'vulnerability', sev],
          ),
        );
        vulnCount++;
      }
    }

    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// scanDocs — heuristics for missing/thin README, LICENSE, CONTRIBUTING
// ---------------------------------------------------------------------------

function fileExistsInsensitive(dir: string, names: string[]): boolean {
  for (const name of names) {
    if (existsSync(join(dir, name))) return true;
  }
  return false;
}

function fileSizeBytes(dir: string, names: string[]): number {
  for (const name of names) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        return statSync(p).size;
      } catch {
        return 0;
      }
    }
  }
  return 0;
}

export async function scanDocs(repo: string): Promise<WorkItem[]> {
  try {
    const items: WorkItem[] = [];

    // 1. README presence + size
    const readmeNames = [
      'README.md', 'README.txt', 'README', 'readme.md', 'Readme.md',
    ];
    const hasReadme = fileExistsInsensitive(repo, readmeNames);
    if (!hasReadme) {
      items.push(
        makeItem(
          repo,
          'doc',
          'doc:missing-readme',
          'Missing README',
          'No README file found at the repo root.',
          3,
          2,
          ['doc', 'readme', 'missing'],
        ),
      );
    } else {
      const size = fileSizeBytes(repo, readmeNames);
      if (size < 300) {
        items.push(
          makeItem(
            repo,
            'doc',
            'doc:thin-readme',
            'README is very short (< 300 bytes)',
            `README is only ${size} bytes. Consider expanding with usage, setup, and contribution info.`,
            2,
            2,
            ['doc', 'readme', 'thin'],
          ),
        );
      }
    }

    // 2. LICENSE presence
    const licenseNames = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'];
    if (!fileExistsInsensitive(repo, licenseNames)) {
      items.push(
        makeItem(
          repo,
          'doc',
          'doc:missing-license',
          'Missing LICENSE file',
          'No LICENSE file found. Open-source projects should declare a license.',
          3,
          1,
          ['doc', 'license', 'missing'],
        ),
      );
    }

    // 3. CONTRIBUTING presence
    const contributingNames = [
      'CONTRIBUTING.md', 'CONTRIBUTING.txt', 'CONTRIBUTING', 'contributing.md',
    ];
    if (!fileExistsInsensitive(repo, contributingNames)) {
      items.push(
        makeItem(
          repo,
          'doc',
          'doc:missing-contributing',
          'Missing CONTRIBUTING file',
          'No CONTRIBUTING guide found. Helps onboard new contributors.',
          2,
          2,
          ['doc', 'contributing', 'missing'],
        ),
      );
    }

    // 4. Low test presence heuristic (no __tests__ dir and no *.test.* / *.spec.* files at top level)
    const testDirExists =
      existsSync(join(repo, '__tests__')) ||
      existsSync(join(repo, 'test')) ||
      existsSync(join(repo, 'tests')) ||
      existsSync(join(repo, 'spec'));

    // Quick check: look for any test file in src or root (bounded, no deep traversal)
    let hasTestFiles = testDirExists;
    if (!hasTestFiles) {
      try {
        const { stdout } = await execFileAsync(
          'find',
          [
            '.',
            '-maxdepth', '3',
            '-not', '-path', '*/node_modules/*',
            '-not', '-path', '*/.git/*',
            '-not', '-path', '*/dist/*',
            '-name', '*.test.*',
            '-o', '-name', '*.spec.*',
          ],
          { cwd: repo, timeout: SCAN_TIMEOUT_MS, maxBuffer: 64 * 1024 },
        );
        hasTestFiles = stdout.trim().length > 0;
      } catch {
        // find not available or error — skip this heuristic
      }
    }

    if (!hasTestFiles) {
      items.push(
        makeItem(
          repo,
          'doc',
          'doc:low-test-presence',
          'Low test coverage signal',
          'No test directories or test files detected. Consider adding tests.',
          3,
          4,
          ['doc', 'tests', 'coverage'],
        ),
      );
    }

    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// scanSecurity — binshield (read-only) if installed, else []
// ---------------------------------------------------------------------------

/**
 * Check if `binshield` is on PATH using `which` / `command -v`.
 * Returns true if found.
 */
async function binshieldAvailable(): Promise<boolean> {
  try {
    await execFileAsync('which', ['binshield'], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export async function scanSecurity(repo: string): Promise<WorkItem[]> {
  try {
    if (!(await binshieldAvailable())) return [];

    // Run binshield in read-only/scan mode.
    // We pass `scan` as a subcommand and `--json` for structured output.
    // If binshield doesn't support these flags it will exit non-zero and we return [].
    const { stdout } = await execFileAsync(
      'binshield',
      ['scan', '--json', repo],
      {
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
        // No cwd needed — we pass repo as arg
      },
    );

    if (!stdout || stdout.trim() === '') return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return [];
    }

    // Accept array of findings or { findings: [...] }
    let findings: unknown[] = [];
    if (Array.isArray(parsed)) {
      findings = parsed;
    } else if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as Record<string, unknown>)['findings'])
    ) {
      findings = (parsed as Record<string, unknown>)['findings'] as unknown[];
    } else {
      return [];
    }

    const items: WorkItem[] = [];
    for (const f of findings) {
      if (f === null || typeof f !== 'object' || Array.isArray(f)) continue;
      const finding = f as Record<string, unknown>;

      const title = typeof finding['title'] === 'string'
        ? finding['title']
        : typeof finding['name'] === 'string'
          ? finding['name']
          : 'binshield finding';

      // Sanitize detail — no secrets (skip any key that looks secret-like)
      const rawDetail = typeof finding['description'] === 'string'
        ? finding['description']
        : typeof finding['detail'] === 'string'
          ? finding['detail']
          : '';
      // Strip anything that looks like a token/key (long hex/base64 strings)
      const detail = rawDetail.replace(/[A-Za-z0-9+/]{32,}/g, '[REDACTED]');

      const sev = typeof finding['severity'] === 'string' ? finding['severity'] : 'medium';
      const value = sev === 'critical' ? 5 : sev === 'high' ? 4 : sev === 'medium' ? 3 : 2;

      items.push(
        makeItem(
          repo,
          'security',
          `security:${title}`,
          title,
          detail,
          value,
          2,
          ['security', 'binshield', sev],
        ),
      );
    }

    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// scanSelfImprove — M54: the self-improving fleet's OWN backlog.
// Self-gated: emits items ONLY for ashlr-hub's own repo (package name
// '@ashlr/hub'). Surfaces pending/skipped tests as coverage the fleet should
// RESTORE — it never proposes deleting a test. Bounded; never throws.
//
// M95 exclusion rules:
//  1. M87: intentional skip (string reason or annotation) → excluded
//  2. PROTECTED safety files (matching guardSafetyTests patterns) → excluded.
//     The fleet must never attempt to un-skip a safety invariant test.
//  3. Platform-gated skips (file/nearby lines reference process.platform,
//     skipIf, darwin/win32/linux guards) → excluded. These skips are correct
//     and engine-declinable; surfacing them produces 0-diff proposals.
// ---------------------------------------------------------------------------

/**
 * True when a line of rg output has the skip/todo/xit token inside a string
 * literal or template literal — i.e. the token is quoted data, not a real call.
 *
 * Strategy: remove all single-quoted, double-quoted, and backtick strings from
 * the content first, then check whether the skip pattern is still present.
 * If the pattern disappears after string-stripping, it was inside a string.
 *
 * Also flags scanner-test fixture files that contain skip tokens as test data
 * (files whose basename matches backlog-quality, anti-clog, or scanners).
 * These files intentionally embed skip-like text for the scanner's own tests.
 */
function isSkipInStringOrFixture(content: string, file: string): boolean {
  // 1. Fixture-file check: scanner test files embed skip tokens as test data
  const base = file.split('/').pop() ?? '';
  if (/backlog-quality|anti-clog|scanners/.test(base)) return true;

  // 2. String-literal check: strip all quoted strings then re-test for skip pattern
  //    We handle: 'single', "double", `template` (no nested escapes needed for this heuristic)
  const SKIP_RE = /\b(it|describe|test)\.(skip|todo)\b|\bxit\b/;
  const stripped = content
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  // If the skip pattern is gone after stripping strings, it was quoted data
  return !SKIP_RE.test(stripped);
}

/**
 * Repo-relative path patterns that identify PROTECTED safety/invariant tests.
 * Must mirror guardSafetyTests SAFETY_FILE_PATTERNS in self.ts exactly.
 * Inlined here to keep scanners.ts self-contained (no circular dep on self.ts).
 */
const PROTECTED_SAFETY_PATTERNS: readonly RegExp[] = [
  /^test\/h\d+[.-].*\.test\.ts$/,   // h1..h8 hardening / invariant suites
  /^test\/m45\.foundry\.test\.ts$/,  // sandboxed-engine containment
  /^test\/m47[._].*\.test\.ts$/,     // merge gate + provenance
  /^test\/m51\.trust\.test\.ts$/,    // tri-tier trust
  /^test\/m52\..*\.test\.ts$/,       // OS confinement
  /^test\/m54\..*\.test\.ts$/,       // self-improvement guard itself
  /daemon-gates/,                    // daemon-no-primitive source grep-guard
  /proposal-only/,
  /\.safety\./,
];

/** True when a repo-relative (or rg-relative) file path is a PROTECTED safety file. */
function isProtectedSafetyFile(filePath: string): boolean {
  const p = filePath.replace(/^\.\//, '');
  return PROTECTED_SAFETY_PATTERNS.some((re) => re.test(p));
}

/**
 * True when a skip is platform-gated — i.e. the surrounding code guards it
 * with a platform check. Heuristic: the skip line itself, or the file content
 * near that line, references process.platform / skipIf alongside a platform
 * name, OR a bare platform-name constant used as a skip condition.
 *
 * Deliberately does NOT match a platform name that merely appears inside a
 * string-reason argument (e.g. it.skip('darwin-only', ...)) — those are
 * already caught by the M87 hasStringReason check and we must not double-fire
 * here in a way that prevents the string-reason skip from being seen as
 * intentional (which it already is, correctly excluded by M87).
 */
function isPlatformGatedSkip(content: string, prevLine: string, fileLines: string[], lineNum: number): boolean {
  // Two distinct patterns:
  //   (a) process.platform reference anywhere in line (definitive platform guard)
  //   (b) skipIf( — a conditional skip utility
  const PLATFORM_GUARD_RE = /process\.platform|skipIf\s*\(/;
  if (PLATFORM_GUARD_RE.test(content)) return true;
  if (PLATFORM_GUARD_RE.test(prevLine)) return true;
  // Check a small window around the skip line (up to 4 lines before/after).
  // Only use the strict guard pattern (not bare OS names) to avoid false positives
  // on string-reason skips that happen to mention an OS name as human text.
  const lo = Math.max(0, lineNum - 4);
  const hi = Math.min(fileLines.length - 1, lineNum + 2);
  for (let i = lo; i <= hi; i++) {
    if (PLATFORM_GUARD_RE.test(fileLines[i] ?? '')) return true;
  }
  return false;
}

export async function scanSelfImprove(repo: string): Promise<WorkItem[]> {
  // Only ashlr-hub's own source produces self-improvement work.
  try {
    const pkgPath = join(repo, 'package.json');
    if (!existsSync(pkgPath)) return [];
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
    if (pkg.name !== '@ashlr/hub') return [];
  } catch {
    return [];
  }

  const items: WorkItem[] = [];
  try {
    const out = await execFileAsync(
      'rg',
      ['-n', '--no-heading', '-e', '\\b(it|describe|test)\\.(skip|todo)\\b', '-e', '\\bxit\\b', 'test'],
      { cwd: repo, timeout: SCAN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    ).catch((e: unknown) => ({ stdout: (e as { stdout?: string })?.stdout ?? '' }));
    const lines = String(out.stdout ?? '').split('\n').filter(Boolean).slice(0, 50);
    for (const line of lines) {
      const m = line.match(/^(.+?):(\d+):(.*)/);
      if (!m) continue;
      const file = m[1]!;
      const ln = m[2]!;
      const content = m[3] ?? '';

      // RULE 0 (M99): skip tokens that appear inside string literals or in
      // scanner fixture files — these are test data for the scanner itself,
      // not real skipped tests. Checking this before reading the file avoids
      // unnecessary I/O for false-positive lines.
      if (isSkipInStringOrFixture(content, file)) continue;

      // RULE 1 (M95): skip PROTECTED safety files — the fleet must never try to
      // un-skip safety/invariant tests (they are gated for a reason and any
      // attempt will be declined by guardSafetyTests before it can be applied).
      if (isProtectedSafetyFile(file)) continue;

      // RULE 2 (M87): intentional-skip detection — do NOT emit for a skip that
      // has an explicit rationale:
      //   (a) the first argument is a non-empty string, e.g. it.skip('darwin only', ...)
      //   (b) the line carries a // skip: / // reason: / @skip annotation comment
      const hasStringReason = /\.(skip|todo)\s*\(\s*['"`]/.test(content);
      const hasAnnotation = /\/\/\s*(skip|reason)\s*:|@skip\b/i.test(content);
      if (hasStringReason || hasAnnotation) continue;

      // Read the surrounding file lines for annotation + platform-gate checks.
      let fileLines: string[] = [];
      let prevLine = '';
      if (Number(ln) > 0) {
        try {
          const filePath = join(repo, file);
          if (existsSync(filePath)) {
            fileLines = readFileSync(filePath, 'utf8').split('\n');
            prevLine = fileLines[Number(ln) - 2] ?? '';
          }
        } catch { /* best-effort — never throws */ }
      }

      // Check prev-line annotation (M87 best-effort).
      if (/\/\/\s*(skip|reason)\s*:|@skip\b/i.test(prevLine)) continue;

      // RULE 3 (M95): platform-gated skip — do NOT emit. These skips are
      // intentionally conditioned on the host OS and will always be declined
      // by frontier engines on environments where the gate doesn't match.
      if (isPlatformGatedSkip(content, prevLine, fileLines, Number(ln) - 1)) continue;

      items.push(
        makeItem(
          repo,
          'self',
          `skip:${file}:${ln}`,
          `Restore skipped test in ${basename(file)}:${ln}`,
          `Bare/unguarded skipped test at ${file}:${ln}. ` +
            `Implement the missing test body or re-enable the assertion — ` +
            `the test scaffold exists; only the implementation is missing. ` +
            `Do NOT delete the test. File: ${file}`,
          3,
          2,
          ['self', 'test-gap'],
        ),
      );
    }
  } catch {
    // never throw
  }
  return items.slice(0, 50);
}

// ---------------------------------------------------------------------------
// scanLint — M101: surface auto-fixable lint errors from a CACHED report.
//
// Bounding strategy (CRITICAL — must never block a tick):
//   1. CACHE-FIRST: only reads a pre-existing cached lint report file; NEVER
//      runs a live lint command on every scan.
//   2. GATE: bails immediately when no lint script exists in package.json.
//   3. CAP: emits at most MAX_LINT_ITEMS items per scan.
//
// Supported cache file names (checked in order, repo root):
//   .lint-cache.json  |  .eslintcache.json  |  lint-results.json  |  eslint-report.json
//
// Expected format: ESLint JSON reporter output —
//   Array<{ filePath, messages: Array<{ ruleId, severity, message, line, column, fix? }> }>
//   Only severity-2 (error) messages with a `fix` property OR a well-known
//   auto-fixable rule are surfaced (avoids deep-semantic errors a fleet engine
//   cannot reliably patch).
//
// Item framing: "Fix the <rule> lint error at <file>:<line>: <message>"
// — single-concern; an engine can run `eslint --fix <file>` or patch one line.
// ---------------------------------------------------------------------------

const MAX_LINT_ITEMS = 5;

/** Cached lint report file names tried in order (repo root). */
const LINT_CACHE_NAMES = [
  '.lint-cache.json',
  '.eslintcache.json',
  'lint-results.json',
  'eslint-report.json',
];

/** Shape of one message entry in an ESLint JSON report. */
interface LintMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
  fix?: unknown;
}

/** Shape of one file entry in an ESLint JSON report. */
interface LintFileResult {
  filePath?: string;
  messages?: LintMessage[];
}

/** Parse a cached ESLint JSON report. Returns file-result array or null. */
function parseLintCache(cachePath: string): LintFileResult[] | null {
  try {
    if (!existsSync(cachePath)) return null;
    const raw = readFileSync(cachePath, 'utf8');
    if (!raw || raw.trim() === '') return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as LintFileResult[];
  } catch {
    return null;
  }
}

/**
 * Well-known ESLint rules that eslint --fix handles automatically.
 * Used as a fallback when `fix` metadata is absent from the cached report.
 */
const FIXABLE_RULE_RE =
  /^(no-unused-vars|prefer-const|eqeqeq|semi|quotes|comma-dangle|no-trailing-spaces|eol-last|no-extra-semi|no-multiple-empty-lines|space-before-blocks|keyword-spacing|arrow-spacing|@typescript-eslint\/no-unused-vars|@typescript-eslint\/prefer-const|import\/order|unused-imports\/no-unused-imports)$/;

export async function scanLint(repo: string): Promise<WorkItem[]> {
  try {
    // GATE: require a lint script in package.json — no lint script → skip.
    const pkgPath = join(repo, 'package.json');
    if (!existsSync(pkgPath)) return [];
    try {
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const scripts = pkg['scripts'];
      if (
        scripts === null ||
        typeof scripts !== 'object' ||
        Array.isArray(scripts)
      ) return [];
      const s = scripts as Record<string, unknown>;
      if (typeof s['lint'] !== 'string' || s['lint'].trim() === '') return [];
    } catch {
      return [];
    }

    // CACHE-FIRST: look for a pre-existing lint report — do NOT run lint live.
    let results: LintFileResult[] | null = null;
    for (const name of LINT_CACHE_NAMES) {
      results = parseLintCache(join(repo, name));
      if (results !== null) break;
    }
    if (results === null) return []; // no cached report → nothing to surface

    // Extract fixable errors (severity 2 only) up to MAX_LINT_ITEMS.
    const items: WorkItem[] = [];
    for (const fileResult of results) {
      if (items.length >= MAX_LINT_ITEMS) break;
      if (!fileResult || typeof fileResult !== 'object') continue;
      const filePath = typeof fileResult.filePath === 'string' ? fileResult.filePath : '';
      if (!filePath) continue;

      // Repo-relative display path
      const displayPath = filePath.startsWith(repo)
        ? filePath.slice(repo.length).replace(/^\//, '')
        : filePath;

      const messages = Array.isArray(fileResult.messages) ? fileResult.messages : [];
      for (const msg of messages) {
        if (items.length >= MAX_LINT_ITEMS) break;
        if (!msg || typeof msg !== 'object') continue;
        if (msg.severity !== 2) continue; // errors only

        const rule = typeof msg.ruleId === 'string' && msg.ruleId ? msg.ruleId : 'lint-error';
        const text = typeof msg.message === 'string' ? msg.message.slice(0, 160) : 'lint error';
        const line = typeof msg.line === 'number' ? msg.line : 0;
        const col = typeof msg.column === 'number' ? msg.column : 0;
        const lineRef = line > 0 ? `:${line}${col > 0 ? `:${col}` : ''}` : '';

        // Only surface when the error has auto-fix metadata OR matches a known fixable rule
        const isFixable = (msg.fix !== undefined && msg.fix !== null) || FIXABLE_RULE_RE.test(rule);
        if (!isFixable) continue;

        items.push(
          makeItem(
            repo,
            'lint',
            `lint:${displayPath}:${line}:${rule}`,
            `Fix the ${rule} lint error at ${displayPath}${lineRef}`,
            `Lint error in ${displayPath}${lineRef}: [${rule}] ${text}. ` +
              `Run \`eslint --fix ${displayPath}\` or manually remove the ${rule} violation ` +
              `at line ${line > 0 ? String(line) : '(see file)'}. ` +
              `Do not touch unrelated code.`,
            2,
            1,
            ['lint', rule, 'auto-fixable'],
          ),
        );
      }
    }

    return items;
  } catch {
    return [];
  }
}

// SCANNERS — all eight, exported as a ReadonlyArray
// ---------------------------------------------------------------------------

export const SCANNERS: ReadonlyArray<(repo: string, cfg?: Pick<AshlrConfig, 'foundry'>) => Promise<WorkItem[]>> = [
  scanIssues,
  scanTodos,
  scanTests,
  scanDeps,
  scanDocs,
  scanSecurity,
  scanSelfImprove, // M54: the fleet's own backlog (self-gated to @ashlr/hub)
  scanLint,        // M101: cached-report lint errors → concrete auto-fixable items
] as const;
