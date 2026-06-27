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
