/**
 * scripts/gate.mjs — the pure parts of the fast local release gate: argument parsing,
 * test selection, and how a vitest run becomes PASS / KNOWN / FAIL. Plus the two data
 * files it reads, which must only name test files that exist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateVitest,
  formatDuration,
  loadKnownFailures,
  loadSmoke,
  lockfileDependencyChanged,
  packageDependencyChanges,
  parseArgs,
  planTests,
  renderTable,
} from '../scripts/gate.mjs';

const repoRoot = join(import.meta.dirname, '..');
const smoke = { backend: ['test/smoke-a.test.ts'], web: ['src/web-ui/smoke-b.test.tsx'] };

describe('parseArgs', () => {
  it('defaults to related mode against the default base', () => {
    expect(parseArgs([])).toEqual({ full: false, base: null, json: false, failFast: false, help: false });
  });

  it('accepts --base in both spellings, --json, --fail-fast, --full', () => {
    expect(parseArgs(['--base', 'v3.11.0', '--json']).base).toBe('v3.11.0');
    expect(parseArgs(['--base=HEAD~3']).base).toBe('HEAD~3');
    expect(parseArgs(['--full', '--fail-fast'])).toMatchObject({ full: true, failFast: true });
  });

  it('rejects unknown flags, a missing ref, and --full with --base', () => {
    expect(() => parseArgs(['--fast'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--base'])).toThrow(/needs a ref/);
    expect(() => parseArgs(['--base', '--json'])).toThrow(/needs a ref/);
    expect(() => parseArgs(['--full', '--base', 'x'])).toThrow(/no effect/);
  });
});

describe('packageDependencyChanges', () => {
  const base = JSON.stringify({ version: '3.11.0', scripts: { a: 'x' }, dependencies: { tar: '1' } });

  it('ignores a version bump or a script edit', () => {
    const next = JSON.stringify({ version: '3.11.1', scripts: { a: 'y', gate: 'z' }, dependencies: { tar: '1' } });
    expect(packageDependencyChanges(base, next)).toEqual([]);
  });

  it('names changed dependency-shaped keys', () => {
    const next = JSON.stringify({ version: '3.11.0', dependencies: { tar: '2' }, overrides: { qs: '1' } });
    expect(packageDependencyChanges(base, next)).toEqual(['dependencies', 'overrides']);
  });

  it('treats an unparseable file as every key changed', () => {
    expect(packageDependencyChanges(base, '{').length).toBeGreaterThan(5);
  });
});

describe('lockfileDependencyChanged', () => {
  const lock = (version: string, tar: string) => JSON.stringify({
    name: '@ashlr/hub', version, lockfileVersion: 3,
    packages: { '': { name: '@ashlr/hub', version }, 'node_modules/tar': { version: tar } },
  });

  it('ignores a release version bump', () => {
    expect(lockfileDependencyChanged(lock('3.11.0', '7.5.22'), lock('3.11.1', '7.5.22'))).toBe(false);
  });

  it('sees a dependency change, a new lockfile, or an unparseable one', () => {
    expect(lockfileDependencyChanged(lock('3.11.0', '7.5.22'), lock('3.11.1', '7.5.23'))).toBe(true);
    expect(lockfileDependencyChanged(null, lock('3.11.1', '7.5.22'))).toBe(true);
    expect(lockfileDependencyChanged(lock('3.11.0', '7.5.22'), '{')).toBe(true);
  });
});

describe('planTests', () => {
  const plan = (changed: string[], dependencyKeys: string[] = [], full = false, lockfileChanged = false) =>
    planTests({ full, changed, dependencyKeys, lockfileChanged, smoke });

  it('runs related tests plus smoke, and drops package.json and the lockfile from the related list', () => {
    const p = plan(['src/core/verse/seats.ts', 'package.json', 'package-lock.json', 'desktop/package.json']);
    expect(p.backend).toEqual({
      mode: 'related',
      reason: '1 changed file(s) + 1 smoke',
      files: ['src/core/verse/seats.ts', 'test/smoke-a.test.ts'],
    });
    expect(p.web.files).toEqual(['src/core/verse/seats.ts', 'src/web-ui/smoke-b.test.tsx']);
  });

  it('runs only the smoke set, without the import graph, when nothing importable changed', () => {
    const expected = { mode: 'smoke', reason: 'no importable change; 1 smoke', files: ['test/smoke-a.test.ts'] };
    expect(plan([]).backend).toEqual(expected);
    expect(plan(['docs/RELEASING-LOCALLY.md', '.gitignore', 'desktop/src-tauri/src/main.rs', 'package.json']).backend)
      .toEqual(expected);
  });

  it('keeps any file that could be a module, including unknown extensions', () => {
    for (const file of ['src/web-ui/x.module.css', 'test/fixtures/a.json', 'src/assets/logo.svg', 'scripts/x.mjs', 'weird.ext']) {
      expect(plan([file]).backend.mode, file).toBe('related');
    }
  });

  it('goes full on a lockfile or dependency change', () => {
    expect(plan(['package-lock.json'], [], false, true).backend)
      .toMatchObject({ mode: 'full', reason: 'package-lock.json dependencies changed' });
    expect(plan(['package.json'], ['devDependencies']).web).toMatchObject({ mode: 'full', reason: 'package.json devDependencies changed' });
  });

  it('goes full per suite on a vitest config or setup file, as vitest itself would', () => {
    const backendSetup = plan(['test/setup/home.ts']);
    expect(backendSetup.backend.mode).toBe('full');
    expect(backendSetup.web.mode).toBe('related');
    const webSetup = plan(['src/web-ui/test/setup.ts']);
    expect(webSetup.web.mode).toBe('full');
    expect(webSetup.backend.mode).toBe('related');
    const config = plan(['vitest.config.web.ts']);
    expect([config.backend.mode, config.web.mode]).toEqual(['full', 'full']);
  });

  it('--full runs everything', () => {
    expect(plan([], [], true).backend).toEqual({ mode: 'full', reason: 'gate:full', files: [] });
  });
});

describe('evaluateVitest', () => {
  const known = new Set(['test/flaky.test.ts']);
  const report = (results: Array<[string, string]>) => ({
    numPassedTests: 9, numFailedTests: 1, numTotalTests: 10, numTotalTestSuites: results.length,
    testResults: results.map(([name, status]) => ({ name: join(repoRoot, name), status })),
  });

  it('passes a clean run', () => {
    const v = evaluateVitest({ exitCode: 0, report: report([['test/a.test.ts', 'passed']]), log: '', known });
    expect(v.status).toBe('pass');
    expect(v.tests).toEqual({ passed: 9, failed: 1, total: 10, files: 1 });
  });

  it('reports a failure in a listed file as known, not failed', () => {
    const v = evaluateVitest({ exitCode: 1, report: report([['test/a.test.ts', 'passed'], ['test/flaky.test.ts', 'failed']]), log: '', known });
    expect(v).toMatchObject({ status: 'known', knownFiles: ['test/flaky.test.ts'], failedFiles: [] });
  });

  it('fails on any unlisted failing file, even next to a known one', () => {
    const v = evaluateVitest({ exitCode: 1, report: report([['test/b.test.ts', 'failed'], ['test/flaky.test.ts', 'failed']]), log: '', known });
    expect(v).toMatchObject({ status: 'fail', failedFiles: ['test/b.test.ts'], knownFiles: ['test/flaky.test.ts'] });
  });

  it('fails on unhandled errors that no file owns', () => {
    const v = evaluateVitest({ exitCode: 1, report: report([['test/flaky.test.ts', 'failed']]), log: '⎯⎯ Unhandled Errors ⎯⎯', known });
    expect(v.status).toBe('fail');
  });

  it('fails when vitest exits non-zero without a failing file, or writes no report', () => {
    expect(evaluateVitest({ exitCode: 1, report: report([['test/a.test.ts', 'passed']]), log: '', known }).status).toBe('fail');
    expect(evaluateVitest({ exitCode: 1, report: null, log: '', known }).status).toBe('fail');
    expect(evaluateVitest({ exitCode: 0, report: null, log: '', known }).status).toBe('pass');
  });
});

describe('output', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(1234)).toBe('1.2s');
    expect(formatDuration(125_000)).toBe('2m05s');
    expect(formatDuration(179_600)).toBe('3m00s');
    expect(formatDuration(59_970)).toBe('1m00s');
  });

  it('renders an aligned table', () => {
    const table = renderTable([
      { name: 'build', status: 'pass', durationMs: 1000, detail: null },
      { name: 'tests-backend', status: 'known', durationMs: 61_000, detail: 'related' },
    ]);
    expect(table.split('\n')).toEqual([
      'step           status  duration  detail',
      '-------------  ------  --------  -------',
      'build          PASS    1.0s',
      'tests-backend  KNOWN   1m01s     related',
    ]);
  });
});

describe('gate data files', () => {
  it('the smoke set names existing test files, each with a reason', () => {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'scripts/gate-smoke.json'), 'utf8'));
    for (const entry of [...raw.backend, ...raw.web]) expect(entry.why, entry.file).toBeTruthy();
    const files = loadSmoke();
    expect(files.backend.length).toBeGreaterThan(0);
    for (const file of [...files.backend, ...files.web]) expect(existsSync(join(repoRoot, file)), file).toBe(true);
    for (const file of files.backend) expect(file).toMatch(/^test\/.+\.test\.ts$/);
    for (const file of files.web) expect(file).toMatch(/^src\/web-ui\/.+\.test\.tsx?$/);
  });

  it('every known failure is an existing test file with a reason', () => {
    for (const [file, reason] of loadKnownFailures()) {
      expect(existsSync(join(repoRoot, file)), file).toBe(true);
      expect(reason.length, file).toBeGreaterThan(10);
    }
  });

  it('npm scripts point at the gate and ship scripts', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts.gate).toBe('node scripts/gate.mjs');
    expect(pkg.scripts['gate:full']).toBe('node scripts/gate.mjs --full');
    expect(pkg.scripts['ship:local']).toBe('node scripts/ship-local.mjs');
  });
});
