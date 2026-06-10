/**
 * conventions.ts — Read-only PROJECT-STANDARDS probes for a single repo (M27).
 *
 * GUARDRAILS (enforced throughout this file):
 *  - READ-ONLY: pure FS reads (existsSync / statSync / readFileSync). NO writes,
 *    NO git mutations, NO installs, NO shell. NEVER mutates a user repo working tree.
 *  - Bounded: a fixed, small set of top-level presence checks + a shallow read of
 *    the root package.json; no deep tree traversal, no unbounded loops.
 *  - Never throws: returns [] on any error so callers (health.ts) stay unblocked.
 *  - No secrets: emitted ConventionFinding values are presence/label metadata only.
 *  - Enrollment-scoping is the CALLER's responsibility (health.ts) — this module
 *    is a pure probe over whatever absolute path it is handed.
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConventionFinding } from '../types.js';

// ---------------------------------------------------------------------------
// Bounds / weights
// ---------------------------------------------------------------------------

/** Minimum README size (bytes) below which it is considered "thin". */
const THIN_README_BYTES = 300;

/** Fixed candidate name sets (no deep traversal — top-level presence only). */
const README_NAMES = ['README.md', 'README.txt', 'README', 'readme.md', 'Readme.md'];
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING'];
const LOCKFILE_NAMES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
];
const TEST_DIR_NAMES = ['test', 'tests', '__tests__', 'spec'];
const CI_PATHS = ['.github/workflows', '.gitlab-ci.yml', '.circleci', 'azure-pipelines.yml', '.travis.yml'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when ANY of `names` exists directly under `dir`. Never throws. */
function anyExists(dir: string, names: string[]): boolean {
  for (const name of names) {
    try {
      if (existsSync(join(dir, name))) return true;
    } catch {
      // ignore — treat as absent
    }
  }
  return false;
}

/** Byte size of the first existing file in `names` under `dir`, else 0. */
function firstSize(dir: string, names: string[]): number {
  for (const name of names) {
    const p = join(dir, name);
    try {
      if (existsSync(p)) return statSync(p).size;
    } catch {
      return 0;
    }
  }
  return 0;
}

/** True when `name` exists directly under `dir` AND is a directory. Never throws. */
function dirExists(dir: string, name: string): boolean {
  try {
    const p = join(dir, name);
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Shallow read of a repo's top-level package.json. Returns null when absent or
 * malformed. Read-only; never throws.
 */
function readPackageJson(repo: string): Record<string, unknown> | null {
  const p = join(repo, 'package.json');
  try {
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed — treat as absent
  }
  return null;
}

/** True when `pkg` has a non-empty "test" script. */
function hasTestScript(pkg: Record<string, unknown> | null): boolean {
  if (pkg === null) return false;
  const scripts = pkg['scripts'];
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return false;
  const test = (scripts as Record<string, unknown>)['test'];
  return typeof test === 'string' && test.trim() !== '';
}

/** True when `pkg` carries a non-empty string field at `key`. */
function hasStringField(pkg: Record<string, unknown>, key: string): boolean {
  const v = pkg[key];
  return typeof v === 'string' && v.trim() !== '';
}

/** True when `pkg` carries a `repository` field (string or object form). */
function hasRepositoryField(pkg: Record<string, unknown>): boolean {
  const v = pkg['repository'];
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const url = (v as Record<string, unknown>)['url'];
    return typeof url === 'string' && url.trim() !== '';
  }
  return false;
}

// ---------------------------------------------------------------------------
// probeConventions — the single public entry point
// ---------------------------------------------------------------------------

/**
 * Probe `repo` (an absolute path) for project-standard conventions.
 *
 * Returns a deterministic, ordered ConventionFinding[] covering:
 *  - README presence + thinness (< THIN_README_BYTES bytes)
 *  - LICENSE presence
 *  - lockfile presence (package-lock.json / yarn.lock / pnpm-lock.yaml / bun.lockb / Cargo.lock / …)
 *  - .gitignore presence
 *  - a test signal (test|tests|__tests__|spec dir, or a package.json "test" script)
 *  - a CI config presence (.github/workflows / .gitlab-ci.yml / .circleci / …)
 *  - (Node projects only) a package.json `license` field
 *  - (Node projects only) a package.json `repository` field
 *
 * Pure FS reads, bounded (fixed check list + one shallow package.json read; no
 * deep traversal), NEVER mutates, NEVER throws (returns [] on failure).
 *
 * Mirrors the read-only presence/size heuristics in
 * portfolio/scanners.ts#scanDocs / #scanTests. Enrollment-scoping is the
 * caller's responsibility (health.ts).
 */
export function probeConventions(repo: string): ConventionFinding[] {
  try {
    const findings: ConventionFinding[] = [];
    const pkg = readPackageJson(repo);

    // 1. README presence + thinness ----------------------------------------
    const hasReadme = anyExists(repo, README_NAMES);
    if (!hasReadme) {
      findings.push({
        key: 'readme',
        label: 'README',
        ok: false,
        weight: 3,
        detail: 'No README file found at the repo root.',
      });
    } else {
      const size = firstSize(repo, README_NAMES);
      const thin = size < THIN_README_BYTES;
      findings.push({
        key: 'readme',
        label: 'README',
        ok: !thin,
        weight: 2,
        detail: thin
          ? `README is only ${size} bytes (< ${THIN_README_BYTES}); consider expanding usage/setup.`
          : `README present (${size} bytes).`,
      });
    }

    // 2. LICENSE file presence ---------------------------------------------
    const hasLicenseFile = anyExists(repo, LICENSE_NAMES);
    findings.push({
      key: 'license',
      label: 'LICENSE file',
      ok: hasLicenseFile,
      weight: 3,
      detail: hasLicenseFile
        ? 'LICENSE file present at the repo root.'
        : 'No LICENSE file found at the repo root.',
    });

    // 3. lockfile presence --------------------------------------------------
    const hasLockfile = anyExists(repo, LOCKFILE_NAMES);
    findings.push({
      key: 'lockfile',
      label: 'Dependency lockfile',
      ok: hasLockfile,
      weight: 3,
      detail: hasLockfile
        ? 'A dependency lockfile is present (reproducible installs).'
        : 'No lockfile found (package-lock.json / yarn.lock / pnpm-lock.yaml / Cargo.lock / …).',
    });

    // 4. .gitignore presence ------------------------------------------------
    const hasGitignore = anyExists(repo, ['.gitignore']);
    findings.push({
      key: 'gitignore',
      label: '.gitignore',
      ok: hasGitignore,
      weight: 2,
      detail: hasGitignore
        ? '.gitignore present at the repo root.'
        : 'No .gitignore found at the repo root.',
    });

    // 5. test signal: a test dir OR a package.json "test" script -----------
    const hasTestDir = TEST_DIR_NAMES.some(name => dirExists(repo, name));
    const testScript = hasTestScript(pkg);
    const hasTests = hasTestDir || testScript;
    findings.push({
      key: 'testdir',
      label: 'Test suite signal',
      ok: hasTests,
      weight: 4,
      detail: hasTests
        ? testScript
          ? 'package.json defines a "test" script.'
          : 'A test directory (test/tests/__tests__/spec) is present.'
        : 'No test directory or package.json "test" script found.',
    });

    // 6. CI config presence -------------------------------------------------
    // .github/workflows is a directory; the rest are files — anyExists covers both.
    const hasCi = anyExists(repo, CI_PATHS);
    findings.push({
      key: 'ci',
      label: 'CI configuration',
      ok: hasCi,
      weight: 3,
      detail: hasCi
        ? 'A CI config is present (.github/workflows / .gitlab-ci.yml / …).'
        : 'No CI config found (.github/workflows / .gitlab-ci.yml / .circleci / …).',
    });

    // 7 & 8. package.json metadata fields (Node projects only) -------------
    // Only probed when a parseable package.json exists, so non-Node repos are
    // not penalized for missing npm-specific metadata.
    if (pkg !== null) {
      const hasLicenseField = hasStringField(pkg, 'license');
      findings.push({
        key: 'pkg-license',
        label: 'package.json license field',
        ok: hasLicenseField,
        weight: 2,
        detail: hasLicenseField
          ? 'package.json declares a "license" field.'
          : 'package.json has no "license" field.',
      });

      const hasRepo = hasRepositoryField(pkg);
      findings.push({
        key: 'pkg-repository',
        label: 'package.json repository field',
        ok: hasRepo,
        weight: 1,
        detail: hasRepo
          ? 'package.json declares a "repository" field.'
          : 'package.json has no "repository" field.',
      });
    }

    return findings;
  } catch {
    // Any unexpected failure — stay unblocked, report nothing.
    return [];
  }
}
