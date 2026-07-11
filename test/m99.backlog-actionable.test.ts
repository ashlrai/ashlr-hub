/**
 * M99 — backlog actionability: fixture false-positives and concrete item framing.
 *
 * Covers two bugs / quality gaps:
 *
 *  1. FALSE-POSITIVE FIX (M99 Rule 0): scanSelfImprove must NOT flag a .skip
 *     token that appears inside a string literal or template string, or inside
 *     a scanner-test fixture file (backlog-quality / anti-clog / scanners in
 *     the filename). Only real `it.skip(` / `describe.skip(` / `xit(` CALLS at
 *     statement position should surface.
 *
 *  2. ACTIONABILITY (M99 Rule A): scanTodos detail must include the file path,
 *     the line number, and the TODO text — so a frontier engine receives a
 *     concrete, single-concern instruction rather than a vague "N markers in file".
 *
 * Hermetic: tmp repos + mocked child_process (mirrors m95/m87 conventions).
 * Uses real `rg` for the real-skip positive case (same as m87).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing scanners (vitest hoists vi.mock)
// ---------------------------------------------------------------------------

let _execFileImpl: ReturnType<typeof vi.fn>;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();

  const mockExecFile = ((...args: unknown[]) => _execFileImpl(...args)) as typeof actual.execFile & {
    [k: symbol]: unknown;
  };
  mockExecFile[promisify.custom] = (
    file: string,
    cmdArgs: readonly string[],
    options: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      _execFileImpl(
        file,
        cmdArgs,
        options,
        (err: (Error & { stdout?: string; stderr?: string }) | null, stdout: string, stderr: string) => {
          if (err) {
            reject(Object.assign(err, { stdout, stderr }));
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });

  return {
    ...actual,
    execFile: mockExecFile,
    spawnSync: (..._args: unknown[]) => ({ pid: 0, output: [], stdout: '[]', stderr: '', status: 0, signal: null }),
  };
});

// ---------------------------------------------------------------------------
// Import AFTER mock hoisting
// ---------------------------------------------------------------------------

import { scanSelfImprove, scanTodos } from '../src/core/portfolio/scanners.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an execFile stub that returns rg output for the given lines. */
function makeRgStub(rgOutput: string): ReturnType<typeof vi.fn> {
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(null, rgOutput, '');
  });
}

/** A real bare `it.skip(` call (no reason string). */
function bareItSkip(body = '() => {}'): string {
  return `it.${'skip'}(${body});`;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m99-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@ashlr/hub' }), 'utf8');
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });

  // Safe default: execFile errors so no real subprocesses run
  _execFileImpl = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(new Error('execFile not configured'), '', '');
  });
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// ===========================================================================
// M99 Rule 0 — false-positive: skip token inside a string literal
// ===========================================================================

describe('M99 Rule 0 — scanSelfImprove does NOT flag skip inside a string literal', () => {
  it('does not flag skip calls mentioned in line comments', async () => {
    const file = 'test/comment-only.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      [
        "import { it } from 'vitest';",
        '// it.skip(() => {}) is an example of syntax the scanner rejects.',
        "it('real test', () => {});",
      ].join('\n'),
      'utf8',
    );

    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(0);
  });

  it('does not flag skip calls mentioned across block comments', async () => {
    const file = 'test/block-comment-only.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      [
        "import { it } from 'vitest';",
        '/* Documentation example:',
        ' * describe.skip(() => {})',
        ' * xit(() => {})',
        ' */',
        "it('real test', () => {});",
      ].join('\n'),
      'utf8',
    );

    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(0);
  });

  it('does not flag a skip method reference that does not disable a test', async () => {
    const file = 'test/method-reference.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      "const skipMethod = it.skip;\nit('real test', () => {});\n",
      'utf8',
    );

    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(0);
  });

  it.each([
    ['test/example.py', '# it.skip(() => {})\n'],
    ['test/example.md', 'Example: it.skip(() => {})\n'],
    ['test/example.json', '{"example":"it.skip(() => {})"}\n'],
  ])('does not interpret non-JavaScript %s examples as test calls', async (file, body) => {
    fs.writeFileSync(path.join(repo, file), body, 'utf8');
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(0);
  });

  it('does not flag regex literals or JSX text examples', async () => {
    const regexFile = 'test/regex.test.ts';
    const jsxFile = 'test/example.test.tsx';
    fs.writeFileSync(path.join(repo, regexFile), 'const re = /it.skip\\(/;\n', 'utf8');
    fs.writeFileSync(path.join(repo, jsxFile), 'const example = <code>describe.skip()</code>;\n', 'utf8');
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(regexFile) || item.detail.includes(jsxFile))).toHaveLength(0);
  });

  it('does not let regex comment tokens hide a later real skip', async () => {
    const file = 'test/regex-before-real.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      'const re = /[/*]/;\nit.skip(() => {});\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('does not let a returned regex hide a later real skip', async () => {
    const file = 'test/returned-regex-before-real.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      'function matcher() { return /[/*]/; }\nit.skip(() => {});\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('does not flag multiline plain JSX text examples', async () => {
    const file = 'test/multiline-example.test.tsx';
    fs.writeFileSync(
      path.join(repo, file),
      'const example = <code>\n  describe.skip(() => {})\n</code>;\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(0);
  });

  it('preserves executable JSX expression containers', async () => {
    const file = 'test/jsx-expression.test.tsx';
    fs.writeFileSync(
      path.join(repo, file),
      'const value = <code>{\n  it.skip(() => {})\n}</code>;\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('preserves JSX expressions that follow rendered text', async () => {
    const file = 'test/jsx-mixed-expression.test.tsx';
    fs.writeFileSync(
      path.join(repo, file),
      'const value = <code>Example:\n  {(() => {\n    it.skip(() => {})\n    return null;\n  })()}\n</code>;\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('preserves executable template interpolation bodies', async () => {
    const file = 'test/template-expression.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      'const value = `${(() => {\n  it.skip(() => {})\n  return "done";\n})()}`;\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('does not treat outer template text as code after nested interpolation', async () => {
    const file = 'test/nested-template-text.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      'const value = `outer ${`inner ${1}`}\n  it.skip(() => {})`;\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(0);
  });

  it('restores code scanning after nested template interpolation', async () => {
    const file = 'test/nested-template-before-real.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      'const value = `outer ${`inner ${1}`} tail`;\nit.skip(() => {});\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('recognizes a string reason after an intervening comment', async () => {
    const file = 'test/commented-reason.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      'it.skip /* rationale */ ("intentional", () => {});\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(0);
  });

  it('recognizes a string reason after a long bounded comment', async () => {
    const file = 'test/long-commented-reason.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      `it.skip /* ${'rationale '.repeat(100)} */ ("intentional", () => {});\n`,
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(0);
  });

  it('does not let tag-shaped strings hide intervening real skips', async () => {
    const file = 'test/tag-string-boundary.test.tsx';
    fs.writeFileSync(
      path.join(repo, file),
      'const open = "<code>";\nit.skip(() => {});\nconst close = "</code>";\n',
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('does not flag a .skip token that lives inside a single-quoted string argument', async () => {
    // This is what the m95 test file does: it.skip is written as a string literal
    // inside a test-data fixture (e.g. `"it.${'skip'}(...)"` or `'it.skip('...')`).
    // The line rg returns looks like a skip call but the token is inside quotes.
    const file = 'test/sample.test.ts';
    // Write a file where .skip appears only in a string — not a real call
    fs.writeFileSync(
      path.join(repo, file),
      [
        "import { it } from 'vitest';",
        // A string containing '.skip' — NOT a real skip call
        "const fixture = 'it.skip(() => {})';",
        "it('real test', () => { expect(fixture).toContain('skip'); });",
      ].join('\n'),
      'utf8',
    );

    // rg finds the line because it matches the pattern, but it's inside a string
    _execFileImpl = makeRgStub(`${file}:2:const fixture = 'it.skip(() => {})';`);

    const items = await scanSelfImprove(repo);
    // Must not flag a skip that lives inside a string literal
    expect(items.filter((i) => i.detail.includes(file))).toHaveLength(0);
  });

  it('does not flag a .skip token inside a double-quoted string', async () => {
    const file = 'test/dq.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      [
        "import { it } from 'vitest';",
        'const s = "describe.skip is a method";',
        "it('check', () => { expect(s).toBeDefined(); });",
      ].join('\n'),
      'utf8',
    );

    _execFileImpl = makeRgStub(`${file}:2:const s = "describe.skip is a method";`);

    const items = await scanSelfImprove(repo);
    expect(items.filter((i) => i.detail.includes(file))).toHaveLength(0);
  });

  it('does not flag a .skip token inside a template literal', async () => {
    const file = 'test/tpl.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      [
        "import { it } from 'vitest';",
        'const msg = `call it.skip to skip a test`;',
        "it('check', () => { expect(msg).toBeDefined(); });",
      ].join('\n'),
      'utf8',
    );

    _execFileImpl = makeRgStub(`${file}:2:const msg = \`call it.skip to skip a test\`;`);

    const items = await scanSelfImprove(repo);
    expect(items.filter((i) => i.detail.includes(file))).toHaveLength(0);
  });

  it('does not flag skip tokens in scanner fixture files (backlog-quality basename)', async () => {
    // The live false-positive: m95.backlog-quality.test.ts contains .skip inside
    // string fixtures for the scanner's own tests. These must never self-flag.
    const file = 'test/m95.backlog-quality.test.ts';
    const absFile = path.join(repo, file);
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
    fs.writeFileSync(
      absFile,
      [
        "// scanner test fixture — .skip appears as string data below",
        "const rgLine = `test/plain.test.ts:3:  it.skip(() => { /* TODO */ });`;",
        "it('fixture test', () => { expect(rgLine).toBeDefined(); });",
      ].join('\n'),
      'utf8',
    );

    // rg finds a line in this file that matches the skip pattern
    _execFileImpl = makeRgStub(`${file}:2:const rgLine = \`test/plain.test.ts:3:  it.skip(() => { /* TODO */ });\`;`);

    const items = await scanSelfImprove(repo);
    // The fixture file itself must not be flagged
    expect(items.filter((i) => i.detail.includes(file))).toHaveLength(0);
  });

  it('does not flag skip tokens in files with "anti-clog" in the name', async () => {
    const file = 'test/m87.anti-clog.test.ts';
    const absFile = path.join(repo, file);
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
    fs.writeFileSync(absFile, "const s = 'it.skip(() => {})';", 'utf8');

    _execFileImpl = makeRgStub(`${file}:1:const s = 'it.skip(() => {})';`);

    const items = await scanSelfImprove(repo);
    expect(items.filter((i) => i.detail.includes(file))).toHaveLength(0);
  });

  it('does not flag skip tokens in files with "scanners" in the name', async () => {
    const file = 'test/m22.scanners.test.ts';
    const absFile = path.join(repo, file);
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
    fs.writeFileSync(absFile, "const s = 'it.skip(() => {})';", 'utf8');

    _execFileImpl = makeRgStub(`${file}:1:const s = 'it.skip(() => {})';`);

    const items = await scanSelfImprove(repo);
    expect(items.filter((i) => i.detail.includes(file))).toHaveLength(0);
  });
});

// ===========================================================================
// M99 Rule 0 — positive: REAL it.skip() at statement position still surfaces
// ===========================================================================

describe('M99 Rule 0 — scanSelfImprove DOES flag a real it.skip() call', () => {
  it('preserves a real skip call before a trailing explanatory comment', async () => {
    const file = 'test/real-before-comment.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      "it.skip(() => {}); // describe.skip here is documentation only\n",
      'utf8',
    );

    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('preserves parameterized skip calls', async () => {
    const file = 'test/real-each.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      'it.skip.each([[1]])("case %s", () => {});\n',
      'utf8',
    );

    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('preserves multiline and modifier-chain skip calls', async () => {
    const multiline = 'test/real-multiline.test.ts';
    const modifier = 'test/real-concurrent.test.ts';
    fs.writeFileSync(path.join(repo, multiline), 'it.skip\n(() => {});\n', 'utf8');
    fs.writeFileSync(path.join(repo, modifier), 'it.concurrent.skip(() => {});\n', 'utf8');
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(multiline))).toHaveLength(1);
    expect(items.filter((item) => item.detail.includes(modifier))).toHaveLength(1);
  });

  it('preserves conventional xit calls with a test title', async () => {
    const file = 'test/real-xit.test.ts';
    fs.writeFileSync(path.join(repo, file), 'xit("disabled test", () => {});\n', 'utf8');
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('does not scan symlinked directories outside the repository', async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'm99-external-'));
    try {
      fs.writeFileSync(path.join(external, 'external.test.ts'), 'it.skip(() => {});\n', 'utf8');
      fs.symlinkSync(external, path.join(repo, 'test', 'external-link'), 'dir');
      const items = await scanSelfImprove(repo);
      expect(items.filter((item) => item.detail.includes('external-link'))).toHaveLength(0);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('does not follow a symlinked test root outside the repository', async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'm99-external-root-'));
    try {
      fs.writeFileSync(path.join(external, 'outside.test.ts'), 'it.skip(() => {});\n', 'utf8');
      fs.rmSync(path.join(repo, 'test'), { recursive: true, force: true });
      fs.symlinkSync(external, path.join(repo, 'test'), 'dir');
      const items = await scanSelfImprove(repo);
      expect(items).toHaveLength(0);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('keeps repo-relative paths intact when the repo has a trailing separator', async () => {
    const file = 'test/trailing-separator.test.ts';
    fs.writeFileSync(path.join(repo, file), 'it.skip(() => {});\n', 'utf8');
    const items = await scanSelfImprove(`${repo}${path.sep}`);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it.each(['test/example.mjsx', 'test/example.mtsx', 'test/example.ctsx'])(
    'does not scan unsupported extension %s',
    async (file) => {
      fs.writeFileSync(path.join(repo, file), 'it.skip(() => {});\n', 'utf8');
      const items = await scanSelfImprove(repo);
      expect(items.filter((item) => item.detail.includes(file))).toHaveLength(0);
    },
  );

  it('preserves a real bare skip in a scanner-named test file', async () => {
    const file = 'test/m22.scanners.test.ts';
    fs.writeFileSync(path.join(repo, file), 'it.skip(() => {});\n', 'utf8');
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes(file))).toHaveLength(1);
  });

  it('does not let excluded markers consume the 50-item output bound', async () => {
    const excluded = Array.from({ length: 50 }, (_unused, index) =>
      `it.skip('intentional ${index}', () => {});`,
    );
    fs.writeFileSync(
      path.join(repo, 'test/cap.test.ts'),
      [...excluded, 'it.skip(() => {});'].join('\n'),
      'utf8',
    );
    const items = await scanSelfImprove(repo);
    expect(items.filter((item) => item.detail.includes('test/cap.test.ts'))).toHaveLength(1);
  });

  it('flags a bare it.skip() call at statement position (not inside a string)', async () => {
    const file = 'test/real.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      [
        "import { it } from 'vitest';",
        bareItSkip('() => { /* implement me */ }'),
      ].join('\n'),
      'utf8',
    );

    // rg returns the real call — no quotes around the skip token
    _execFileImpl = makeRgStub(`${file}:2:${bareItSkip('() => { /* implement me */ }')}`);

    const items = await scanSelfImprove(repo);
    expect(items.length).toBeGreaterThanOrEqual(1);
    const item = items.find((i) => i.detail.includes(file));
    expect(item).toBeDefined();
    expect(item!.source).toBe('self');
  });

  it('mixed: string-literal skip on line 2 NOT flagged; real skip on line 3 IS flagged', async () => {
    const file = 'test/mixed.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      [
        "import { it } from 'vitest';",
        "const s = 'it.skip';",           // skip token in string — should NOT flag
        bareItSkip('() => {}'),            // real call — SHOULD flag
      ].join('\n'),
      'utf8',
    );

    // rg returns both lines
    _execFileImpl = makeRgStub(
      [
        `${file}:2:const s = 'it.skip';`,
        `${file}:3:${bareItSkip('() => {}')}`,
      ].join('\n'),
    );

    const items = await scanSelfImprove(repo);

    // Only line 3 (the real call) should surface
    const refs = items.filter((i) => i.detail.includes(file));
    expect(refs.length).toBe(1);
    expect(refs[0]!.title).toMatch(/:3$/);
  });
});

// ===========================================================================
// M99 Rule A — scanTodos: detail is concrete, scoped, and file+line-anchored
// ===========================================================================

describe('M99 Rule A — scanTodos detail includes file path, line number, and TODO text', () => {
  it('detail contains the file path so the engine knows what to edit', async () => {
    const file = 'src/util.ts';
    const content = `// TODO: add error handling for the null case\nexport function foo() {}\n`;
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content, 'utf8');

    // Stub rg to return a real rg-n line with line number
    _execFileImpl = makeRgStub(`${file}:1:// TODO: add error handling for the null case`);

    const items = await scanTodos(repo, { foundry: { scanTodos: true } }); // M136: opt in
    expect(items.length).toBeGreaterThanOrEqual(1);
    const item = items.find((i) => i.source === 'todo');
    expect(item).toBeDefined();
    // Detail must name the file
    expect(item!.detail).toContain(file);
  });

  it('detail contains the line number so the engine can jump directly to the site', async () => {
    const file = 'src/core/backlog.ts';
    _execFileImpl = makeRgStub(`${file}:42:// FIXME: this crashes when queue is empty`);

    const items = await scanTodos(repo, { foundry: { scanTodos: true } }); // M136: opt in
    expect(items.length).toBeGreaterThanOrEqual(1);
    const item = items[0]!;
    // Detail must reference the line number
    expect(item.detail).toContain(':42');
    // Title must reference the line number
    expect(item.title).toMatch(/:42/);
  });

  it('detail includes the actual TODO comment text (not just a count)', async () => {
    const file = 'src/scanner.ts';
    const todoText = 'TODO: implement retry with exponential backoff';
    _execFileImpl = makeRgStub(`${file}:17:// ${todoText}`);

    const items = await scanTodos(repo, { foundry: { scanTodos: true } }); // M136: opt in
    expect(items.length).toBeGreaterThanOrEqual(1);
    const item = items[0]!;
    // Detail must quote the TODO text so the engine knows what to implement
    expect(item.detail).toContain('implement retry with exponential backoff');
  });

  it('detail contains an action verb ("Implement") so this is a concrete task', async () => {
    const file = 'src/util.ts';
    _execFileImpl = makeRgStub(`${file}:5:// TODO: validate input`);

    const items = await scanTodos(repo, { foundry: { scanTodos: true } }); // M136: opt in
    expect(items.length).toBeGreaterThanOrEqual(1);
    const item = items[0]!;
    // Must include an action directive — not just passive description
    expect(item.detail).toMatch(/implement|fix|resolve|remove/i);
  });

  it('returns [] when rg finds nothing', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error & { code?: number } | null, stdout: string, stderr: string) => void;
      if (typeof cb === 'function') {
        const err = Object.assign(new Error('exit 1'), { code: 1 }) as Error & { code: number };
        cb(err, '', '');
      }
    });

    const items = await scanTodos(repo);
    expect(items).toEqual([]);
  });

  it('never throws on any error shape', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb === 'function') cb(new Error('rg not found'), '', '');
    });
    await expect(scanTodos(repo)).resolves.toBeDefined();
  });
});
