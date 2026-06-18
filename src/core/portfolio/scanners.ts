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

import type { WorkItem, WorkSource } from '../types.js';
import { listIssues, githubStatus } from '../integrations/github.js';

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
// ---------------------------------------------------------------------------

export async function scanIssues(repo: string): Promise<WorkItem[]> {
  try {
    const issues = listIssues(repo);
    if (!Array.isArray(issues) || issues.length === 0) return [];

    const items: WorkItem[] = [];

    for (const issue of issues) {
      // Value heuristic: all open issues are worth attention.
      // We don't have label/age data from the current listIssues shape
      // (it returns number, title, url, state, author), so use a flat value=3.
      const value = 3;
      const effort = 3;

      items.push(
        makeItem(
          repo,
          'issue',
          `issue:${issue.number}`,
          `Issue #${issue.number}: ${issue.title}`,
          issue.url,
          value,
          effort,
          ['issue', `#${issue.number}`],
        ),
      );
    }

    return items;
  } catch {
    return [];
  }
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

export async function scanTodos(repo: string): Promise<WorkItem[]> {
  try {
    const raw = await rgOrGrep(repo);
    if (!raw || raw.trim() === '') return [];

    const lines = raw.split('\n').filter(Boolean).slice(0, MAX_TODO_HITS);

    // Cluster by file: emit one WorkItem per file (to avoid flooding).
    const byFile = new Map<string, { count: number; sample: string; tags: string[] }>();

    for (const line of lines) {
      // rg/grep -n output: "path/to/file:42:...comment..."
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const rest = line.slice(colonIdx + 1);
      const colonIdx2 = rest.indexOf(':');
      const filePath = line.slice(0, colonIdx);
      const commentText = colonIdx2 >= 0 ? rest.slice(colonIdx2 + 1).trim() : rest.trim();

      // Detect which marker type
      const tags: string[] = [];
      if (/TODO/i.test(commentText)) tags.push('todo');
      if (/FIXME/i.test(commentText)) tags.push('fixme');
      if (/HACK/i.test(commentText)) tags.push('hack');
      if (/XXX/i.test(commentText)) tags.push('xxx');

      const existing = byFile.get(filePath);
      if (existing) {
        existing.count++;
        for (const t of tags) {
          if (!existing.tags.includes(t)) existing.tags.push(t);
        }
      } else {
        byFile.set(filePath, { count: 1, sample: commentText.slice(0, 120), tags });
      }
    }

    const items: WorkItem[] = [];
    for (const [filePath, info] of byFile) {
      const plural = info.count > 1 ? `${info.count} markers` : '1 marker';
      items.push(
        makeItem(
          repo,
          'todo',
          `todo:${filePath}`,
          `${plural} in ${filePath}`,
          info.sample,
          2,
          2,
          ['todo', ...info.tags],
        ),
      );
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
          4,
          2,
          ['test', 'ci', 'failing'],
        ),
      );
    } else if (status.isRepo && status.ci === 'pending') {
      items.push(
        makeItem(
          repo,
          'test',
          'test:ci-pending',
          'CI is pending',
          `GitHub Actions: latest run is still in progress for ${status.repo ?? repo}`,
          2,
          1,
          ['test', 'ci', 'pending'],
        ),
      );
    }

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
// ---------------------------------------------------------------------------

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
      const m = line.match(/^(.+?):(\d+):/);
      if (!m) continue;
      const file = m[1]!;
      const ln = m[2]!;
      items.push(
        makeItem(
          repo,
          'self',
          `skip:${file}:${ln}`,
          `Restore skipped test in ${basename(file)}:${ln}`,
          `A pending/skipped test at ${file}:${ln} reduces invariant coverage. ` +
            `Implement or re-enable it — never delete a safety test.`,
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

// SCANNERS — all seven, exported as a ReadonlyArray
// ---------------------------------------------------------------------------

export const SCANNERS: ReadonlyArray<(repo: string) => Promise<WorkItem[]>> = [
  scanIssues,
  scanTodos,
  scanTests,
  scanDeps,
  scanDocs,
  scanSecurity,
  scanSelfImprove, // M54: the fleet's own backlog (self-gated to @ashlr/hub)
] as const;
