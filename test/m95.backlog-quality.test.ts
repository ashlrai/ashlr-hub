/**
 * M95 — backlog quality: scanners produce ACTIONABLE items.
 *
 * Evidence from live fleet tick failures:
 *  - "Restore skipped test in m52.confine.test.ts" → PROTECTED safety file → declined
 *  - "Issue #1: Windows support" → whole epic issue → too big → declined
 *  - bare dep bump with no scope → 0-diff
 *
 * This suite verifies the three M95 exclusion/framing rules:
 *
 *  1. scanSelfImprove EXCLUDES skips in PROTECTED safety files (m52.*, m45.foundry,
 *     m47.*, m51.trust, m54.*, h1-h8, *.safety.*, daemon-gates, proposal-only).
 *  2. scanSelfImprove EXCLUDES platform-gated skips (process.platform / skipIf /
 *     darwin / win32 / linux guards in file or nearby lines).
 *  3. scanSelfImprove STILL surfaces a plain, restorable bare skip.
 *  4. scanIssues SCOPES epic/large issues (title contains epic keywords) to a
 *     concrete first-step item rather than handing the whole issue.
 *  5. scanIssues handles concrete (non-epic) issues with a scoped instruction.
 *  6. All item summaries/details are concrete: contain file/scope guidance.
 *
 * Hermetic: tmp repos + mocked gh (spawnSync) output.
 * Mirrors m22/m87 conventions: no real gh/rg/npm invocations for mocked paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing scanners (vitest hoists vi.mock)
// ---------------------------------------------------------------------------

// Track mock state in a closure so individual tests can reconfigure.
let _execFileImpl: ReturnType<typeof vi.fn>;
let _spawnSyncImpl: ReturnType<typeof vi.fn>;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();

  // Mirror the real execFile promisify.custom so `const { stdout } = await execFileAsync(...)` works.
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
    spawnSync: (...args: unknown[]) => _spawnSyncImpl(...args),
  };
});

// ---------------------------------------------------------------------------
// Import AFTER mock hoisting
// ---------------------------------------------------------------------------

import { scanSelfImprove, scanIssues } from '../src/core/portfolio/scanners.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a spawnSync stub that returns a gh issue list JSON payload. */
function makeSpawnSyncIssues(issues: Array<{ number: number; title: string; url: string; state: string; author: string }>): ReturnType<typeof vi.fn> {
  return vi.fn((_bin: unknown, args: unknown[]) => {
    const argArr = args as string[];
    // gh repo view → return a valid repo slug so listIssues proceeds
    if (argArr.includes('repo') && argArr.includes('view')) {
      return { pid: 1, output: [], stdout: JSON.stringify({ nameWithOwner: 'test/repo' }), stderr: '', status: 0, signal: null };
    }
    // gh issue list → return our payload
    if (argArr.includes('issue') && argArr.includes('list')) {
      return { pid: 1, output: [], stdout: JSON.stringify(issues), stderr: '', status: 0, signal: null };
    }
    // gh pr list → return empty
    if (argArr.includes('pr') && argArr.includes('list')) {
      return { pid: 1, output: [], stdout: '[]', stderr: '', status: 0, signal: null };
    }
    // gh run list → return empty (CI: none)
    return { pid: 1, output: [], stdout: '[]', stderr: '', status: 0, signal: null };
  });
}

/** Build an execFile stub that returns rg output for the given lines. */
function makeRgStub(rgOutput: string): ReturnType<typeof vi.fn> {
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(null, rgOutput, '');
  });
}

function bareItSkip(body = '() => {}'): string {
  return `it.${'skip'}(${body});`;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m95-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@ashlr/hub' }), 'utf8');
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });

  // Safe defaults: execFile errors (no real subprocesses), spawnSync returns empty
  _execFileImpl = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(new Error('execFile not configured'), '', '');
  });
  _spawnSyncImpl = vi.fn(() => ({ pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null }));
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// ===========================================================================
// scanSelfImprove — PROTECTED safety file exclusions (M95 Rule 1)
// ===========================================================================

describe('M95 scanSelfImprove — PROTECTED safety files are excluded', () => {
  /**
   * Each protected file pattern that must be excluded from the backlog.
   * The fleet must never try to un-skip a safety/invariant test.
   */
  const PROTECTED_CASES: Array<{ label: string; file: string }> = [
    { label: 'm52.confine (OS confinement)', file: 'test/m52.confine.test.ts' },
    { label: 'm52.sandbox (OS confinement variant)', file: 'test/m52.sandbox.test.ts' },
    { label: 'm45.foundry (sandboxed-engine containment)', file: 'test/m45.foundry.test.ts' },
    { label: 'm47.merge (merge gate)', file: 'test/m47.merge.test.ts' },
    { label: 'm47_provenance (merge gate variant)', file: 'test/m47_provenance.test.ts' },
    { label: 'm51.trust (tri-tier trust)', file: 'test/m51.trust.test.ts' },
    { label: 'm54.self (self-improvement guard)', file: 'test/m54.self.test.ts' },
    { label: 'h1 hardening suite', file: 'test/h1-invariants.test.ts' },
    { label: 'h8 hardening suite', file: 'test/h8-safety.test.ts' },
    { label: '*.safety.* pattern', file: 'test/fleet.safety.test.ts' },
  ];

  for (const { label, file } of PROTECTED_CASES) {
    it(`EXCLUDES a bare skip in ${label} (${file})`, async () => {
      // Write the protected test file with a plain bare skip (no reason string)
      const absFile = path.join(repo, file);
      fs.mkdirSync(path.dirname(absFile), { recursive: true });
      fs.writeFileSync(
        absFile,
        [
          "import { it } from 'vitest';",
          bareItSkip('() => { /* protected invariant */ }'),
        ].join('\n'),
        'utf8',
      );

      // Stub rg to return the skip line as if it found it
      const rgLine = `${file}:2:${bareItSkip('() => { /* protected invariant */ }')}`;
      _execFileImpl = makeRgStub(rgLine);

      const items = await scanSelfImprove(repo);

      // No item should reference the protected file
      const refs = items.filter(
        (i) => i.title.includes(path.basename(file)) || i.detail.includes(file),
      );
      expect(refs).toHaveLength(0);
    });
  }

  it('EXCLUDES a skip in m52.confine.test.ts specifically (the live-tick failure case)', async () => {
    const protectedFile = 'test/m52.confine.test.ts';
    const absFile = path.join(repo, protectedFile);
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
    fs.writeFileSync(
      absFile,
      bareItSkip('() => { expect(true).toBe(true); }'),
      'utf8',
    );

    _execFileImpl = makeRgStub(`${protectedFile}:1:${bareItSkip('() => { expect(true).toBe(true); }')}`);

    const items = await scanSelfImprove(repo);

    expect(items.every((i) => !i.title.includes('m52.confine'))).toBe(true);
    expect(items.every((i) => !i.detail.includes('m52.confine'))).toBe(true);
  });
});

// ===========================================================================
// scanSelfImprove — platform-gated skip exclusion (M95 Rule 2)
// ===========================================================================

describe('M95 scanSelfImprove — platform-gated skips are excluded', () => {
  it('EXCLUDES a skip with process.platform guard on the same line', async () => {
    const file = 'test/sample.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      [
        "import { it } from 'vitest';",
        `if (process.platform === "darwin") ${bareItSkip()}`,
      ].join('\n'),
      'utf8',
    );

    _execFileImpl = makeRgStub(`${file}:2:if (process.platform === "darwin") ${bareItSkip()}`);

    const items = await scanSelfImprove(repo);
    // The darwin-gated skip must not surface
    expect(items.filter((i) => i.detail.includes(file))).toHaveLength(0);
  });

  it('EXCLUDES a skip where the previous line references process.platform', async () => {
    const file = 'test/platform.test.ts';
    const content = [
      "import { it } from 'vitest';",
      'const skip = process.platform !== "linux";',
      bareItSkip(),
    ].join('\n');
    fs.writeFileSync(path.join(repo, file), content, 'utf8');

    // rg reports line 3 as the skip
    _execFileImpl = makeRgStub(`${file}:3:${bareItSkip()}`);

    const items = await scanSelfImprove(repo);
    expect(items.filter((i) => i.detail.includes(file))).toHaveLength(0);
  });

  it('EXCLUDES a skip with skipIf guard nearby', async () => {
    const file = 'test/skipif.test.ts';
    const content = [
      "import { it } from 'vitest';",
      'const skipOnWin = skipIf(process.platform === "win32");',
      bareItSkip(),
    ].join('\n');
    fs.writeFileSync(path.join(repo, file), content, 'utf8');

    _execFileImpl = makeRgStub(`${file}:3:${bareItSkip()}`);

    const items = await scanSelfImprove(repo);
    expect(items.filter((i) => i.detail.includes(file))).toHaveLength(0);
  });
});

// ===========================================================================
// scanSelfImprove — STILL surfaces genuine bare skips (M95 Rule 3)
// ===========================================================================

describe('M95 scanSelfImprove — genuine bare skips still surface', () => {
  it('surfaces a plain bare skip in a non-protected, non-platform-gated file', async () => {
    const file = 'test/plain.test.ts';
    fs.writeFileSync(
      path.join(repo, file),
      [
        "import { it } from 'vitest';",
        "describe('suite', () => {",
        `  ${bareItSkip('() => { /* TODO: implement */ }')}`,
        '});',
      ].join('\n'),
      'utf8',
    );

    _execFileImpl = makeRgStub(`${file}:3:  ${bareItSkip('() => { /* TODO: implement */ }')}`);

    const items = await scanSelfImprove(repo);

    expect(items.length).toBeGreaterThanOrEqual(1);
    const item = items.find((i) => i.detail.includes(file));
    expect(item).toBeDefined();
    expect(item!.source).toBe('self');
  });

  it('mixed file: protected file excluded, plain file still surfaces', async () => {
    const protectedFile = 'test/m52.confine.test.ts';
    const plainFile = 'test/plain.test.ts';

    const absProtected = path.join(repo, protectedFile);
    fs.mkdirSync(path.dirname(absProtected), { recursive: true });
    fs.writeFileSync(absProtected, bareItSkip(), 'utf8');
    fs.writeFileSync(path.join(repo, plainFile), bareItSkip(), 'utf8');

    // rg returns both
    _execFileImpl = makeRgStub(
      [
        `${protectedFile}:1:${bareItSkip()}`,
        `${plainFile}:1:${bareItSkip()}`,
      ].join('\n'),
    );

    const items = await scanSelfImprove(repo);

    // Protected file must not appear
    expect(items.every((i) => !i.title.includes('m52.confine'))).toBe(true);
    // Plain file must appear
    expect(items.some((i) => i.detail.includes(plainFile))).toBe(true);
  });
});

// ===========================================================================
// scanSelfImprove — summary concreteness (M95 Rule 6)
// ===========================================================================

describe('M95 scanSelfImprove — item details are concrete and scoped', () => {
  it('detail contains the file path so the engine knows what to edit', async () => {
    const file = 'test/concrete.test.ts';
    fs.writeFileSync(path.join(repo, file), bareItSkip(), 'utf8');
    _execFileImpl = makeRgStub(`${file}:1:${bareItSkip()}`);

    const items = await scanSelfImprove(repo);
    const item = items.find((i) => i.source === 'self');
    expect(item).toBeDefined();
    // Detail must name the file so the engine knows the edit target
    expect(item!.detail).toMatch(/test\/concrete\.test\.ts/);
    // Detail must give a concrete instruction (not just a URL or vague label)
    expect(item!.detail.length).toBeGreaterThan(40);
  });
});

// ===========================================================================
// scanIssues — epic/large issue scoping (M95 Rule 4)
// ===========================================================================

describe('M95 scanIssues — epic issues are scoped to a first-step item', () => {
  const EPIC_TITLES: Array<{ title: string; keyword: string }> = [
    { title: 'Windows support', keyword: 'windows support' },
    { title: 'Add support for Linux arm64', keyword: 'support' },
    { title: 'Roadmap: v3 rewrite', keyword: 'roadmap' },
    { title: 'Epic: fleet intelligence overhaul', keyword: 'epic' },
    { title: 'Tracking: implement multi-backend routing', keyword: 'tracking' },
    { title: 'Meta: migrate all tests to vitest', keyword: 'meta' },
    { title: 'Initiative: port to Bun runtime', keyword: 'initiative' },
  ];

  for (const { title, keyword } of EPIC_TITLES) {
    it(`scopes epic issue "${title}" (keyword: ${keyword})`, async () => {
      _spawnSyncImpl = makeSpawnSyncIssues([
        { number: 42, title, url: 'https://github.com/test/repo/issues/42', state: 'open', author: 'user' },
      ]);

      const items = await scanIssues(repo);

      expect(items).toHaveLength(1);
      const item = items[0]!;

      // Title should NOT be a bare "Issue #42: <epic title>" — must be scoped
      expect(item.title).toMatch(/smallest concrete fix|investigate/i);
      // Detail must instruct scoped investigation, not hand the whole issue
      expect(item.detail).toMatch(/smallest|sub-problem|focused/i);
      // Detail must include the issue URL so the engine can read it
      expect(item.detail).toContain('https://github.com/test/repo/issues/42');
      // Tags should include 'scoped' or 'epic' to signal this is a scoped item
      expect(item.tags.some((t) => t === 'scoped' || t === 'epic')).toBe(true);
    });
  }

  it('scopes the live-tick failure case: "Issue #1: Windows support"', async () => {
    _spawnSyncImpl = makeSpawnSyncIssues([
      { number: 1, title: 'Windows support', url: 'https://github.com/test/repo/issues/1', state: 'open', author: 'user' },
    ]);

    const items = await scanIssues(repo);

    expect(items).toHaveLength(1);
    const item = items[0]!;

    // Must NOT hand the whole issue verbatim
    expect(item.title).not.toBe('Issue #1: Windows support');
    // Must instruct focused first-step
    expect(item.detail).toMatch(/smallest|sub-problem|focused/i);
  });
});

// ===========================================================================
// scanIssues — concrete non-epic issues (M95 Rule 5)
// ===========================================================================

describe('M95 scanIssues — concrete issues get scoped instructions', () => {
  it('non-epic issue title gets a scoped detail (not just a URL)', async () => {
    _spawnSyncImpl = makeSpawnSyncIssues([
      {
        number: 7,
        title: 'scanDeps crashes when package.json has no scripts field',
        url: 'https://github.com/test/repo/issues/7',
        state: 'open',
        author: 'user',
      },
    ]);

    const items = await scanIssues(repo);

    expect(items).toHaveLength(1);
    const item = items[0]!;

    // Detail must be more than just the URL
    expect(item.detail.length).toBeGreaterThan(item.title.length);
    // Detail must contain the URL so the engine can read the issue
    expect(item.detail).toContain('https://github.com/test/repo/issues/7');
    // Detail must contain scoped instruction keywords
    expect(item.detail).toMatch(/focused fix|self-contained|relevant file/i);
  });

  it('non-epic item is not tagged as epic or scoped', async () => {
    _spawnSyncImpl = makeSpawnSyncIssues([
      { number: 5, title: 'Fix typo in README', url: 'https://github.com/test/repo/issues/5', state: 'open', author: 'user' },
    ]);

    const items = await scanIssues(repo);
    expect(items).toHaveLength(1);
    expect(items[0]!.tags).not.toContain('epic');
    // title should directly reference the issue
    expect(items[0]!.title).toMatch(/#5/);
  });

  it('returns [] when listIssues returns empty (no gh or no issues)', async () => {
    // spawnSync returns status 1 → listIssues returns []
    _spawnSyncImpl = vi.fn(() => ({ pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null }));

    const items = await scanIssues(repo);
    expect(items).toEqual([]);
  });

  it('never throws on any error shape', async () => {
    _spawnSyncImpl = vi.fn(() => { throw new Error('spawnSync threw'); });
    await expect(scanIssues(repo)).resolves.toBeDefined();
  });
});

// ===========================================================================
// scanIssues — mixed batch: epic and concrete together
// ===========================================================================

describe('M95 scanIssues — mixed epic + concrete batch', () => {
  it('scopes epics and preserves concrete items in the same batch', async () => {
    _spawnSyncImpl = makeSpawnSyncIssues([
      { number: 1, title: 'Windows support', url: 'https://github.com/test/repo/issues/1', state: 'open', author: 'user' },
      { number: 2, title: 'Fix null dereference in backlog.ts', url: 'https://github.com/test/repo/issues/2', state: 'open', author: 'user' },
      { number: 3, title: 'Epic: full rewrite of scanner pipeline', url: 'https://github.com/test/repo/issues/3', state: 'open', author: 'user' },
    ]);

    const items = await scanIssues(repo);

    expect(items).toHaveLength(3);

    // #1 (Windows support) — epic → scoped
    const item1 = items.find((i) => i.tags.includes('#1'))!;
    expect(item1).toBeDefined();
    expect(item1.tags).toContain('scoped');

    // #2 (concrete bug) — not scoped as epic
    const item2 = items.find((i) => i.tags.includes('#2'))!;
    expect(item2).toBeDefined();
    expect(item2.tags).not.toContain('epic');
    expect(item2.detail).toMatch(/focused fix|self-contained|relevant file/i);

    // #3 (epic rewrite) → scoped
    const item3 = items.find((i) => i.tags.includes('#3'))!;
    expect(item3).toBeDefined();
    expect(item3.tags).toContain('scoped');
  });
});
