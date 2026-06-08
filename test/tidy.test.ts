/**
 * Tests for src/core/tidy.ts
 *
 * Verified behaviors:
 *  - planTidy never moves keepers (by basename or absolute path)
 *  - planTidy never moves symlinks
 *  - planTidy never moves git repos
 *  - planTidy never moves entries inside github/ roots
 *  - Rule matching: ext, glob, regex
 *  - Collision skip: if dest file already exists, that move is skipped
 *  - applyTidy executes moves (mkdir -p + rename)
 *  - applyTidy is idempotent (source gone => skip gracefully)
 *
 * All tests are hermetic — use os.tmpdir(), never touch the real Desktop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync,
  symlinkSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { AshlrConfig, TidyRule } from '../src/core/types.js';
import { planTidy, applyTidy } from '../src/core/tidy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'ashlr-tidy-test-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal valid AshlrConfig whose root is `base`.
 * Pass tidyRules, keepers etc to override.
 */
function makeConfig(
  base: string,
  overrides: Partial<AshlrConfig> = {},
): AshlrConfig {
  return {
    version: 1,
    roots: [base],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
    ...overrides,
  };
}

function makeRule(match: string, matchType: TidyRule['matchType'], dest: string): TidyRule {
  return { match, matchType, dest };
}

// ---------------------------------------------------------------------------
// planTidy — keepers
// ---------------------------------------------------------------------------

describe('planTidy — keepers', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('never moves a file whose basename matches a keeper', () => {
    const file = join(tmp, 'Rent Application.pdf');
    writeFileSync(file, 'dummy');
    const dest = join(tmp, 'Documents');
    mkdirSync(dest, { recursive: true });

    const cfg = makeConfig(tmp, {
      keepers: ['Rent Application.pdf'],
      tidyRules: [makeRule('.pdf', 'ext', dest)],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === file);
    expect(moved).toBeUndefined();
    const skipped = plan.skipped.find(s => s.path === file);
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toMatch(/keeper/i);
  });

  it('never moves a file whose absolute path matches a keeper', () => {
    const file = join(tmp, 'important.txt');
    writeFileSync(file, 'keep me');
    const dest = join(tmp, 'Docs');
    mkdirSync(dest, { recursive: true });

    const cfg = makeConfig(tmp, {
      keepers: [file], // absolute path keeper
      tidyRules: [makeRule('.txt', 'ext', dest)],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === file);
    expect(moved).toBeUndefined();
    const skipped = plan.skipped.find(s => s.path === file);
    expect(skipped).toBeDefined();
  });

  it('never moves a directory that is a keeper', () => {
    const dir = join(tmp, 'ASHLRAI');
    mkdirSync(dir, { recursive: true });
    const dest = join(tmp, 'Archive');
    mkdirSync(dest, { recursive: true });

    const cfg = makeConfig(tmp, {
      keepers: ['ASHLRAI'],
      tidyRules: [makeRule('ASHLRAI', 'glob', dest)],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === dir);
    expect(moved).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// planTidy — never moves git repos or symlinks
// ---------------------------------------------------------------------------

describe('planTidy — git repos and symlinks protected', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('never moves a git repo at the top level of a root', () => {
    const repo = join(tmp, 'my-repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init', { cwd: repo, stdio: 'pipe' });

    const dest = join(tmp, 'Archive');
    mkdirSync(dest, { recursive: true });

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('my-repo', 'glob', dest)],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === repo);
    expect(moved).toBeUndefined();
    const skipped = plan.skipped.find(s => s.path === repo);
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toMatch(/repo/i);
  });

  it('never moves a symlink', () => {
    const target = join(tmp, 'target');
    mkdirSync(target, { recursive: true });
    const link = join(tmp, 'my-link');
    symlinkSync(target, link);

    const dest = join(tmp, 'Links');
    mkdirSync(dest, { recursive: true });

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('my-link', 'glob', dest)],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === link);
    expect(moved).toBeUndefined();
    const skipped = plan.skipped.find(s => s.path === link);
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toMatch(/symlink/i);
  });
});

// ---------------------------------------------------------------------------
// planTidy — rule matching: ext
// ---------------------------------------------------------------------------

describe('planTidy — rule matching: ext', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('matches a .pdf file with ext rule ".pdf"', () => {
    const file = join(tmp, 'invoice.pdf');
    writeFileSync(file, 'dummy');
    const dest = join(tmp, 'Documents');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('.pdf', 'ext', dest)],
    });

    const plan = planTidy(cfg);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].from).toBe(file);
    expect(plan.moves[0].to).toBe(join(dest, 'invoice.pdf'));
  });

  it('does not match a .txt file with ext rule ".pdf"', () => {
    const file = join(tmp, 'notes.txt');
    writeFileSync(file, 'hello');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('.pdf', 'ext', join(tmp, 'Documents'))],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === file);
    expect(moved).toBeUndefined();
  });

  it('matches multiple files with the same ext rule', () => {
    writeFileSync(join(tmp, 'a.pdf'), 'a');
    writeFileSync(join(tmp, 'b.pdf'), 'b');
    writeFileSync(join(tmp, 'c.txt'), 'c');
    const dest = join(tmp, 'PDFs');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('.pdf', 'ext', dest)],
    });

    const plan = planTidy(cfg);
    const pdfMoves = plan.moves.filter(m => m.from.endsWith('.pdf'));
    expect(pdfMoves).toHaveLength(2);
  });

  it('ext rule without leading dot does not throw and returns valid plan shape', () => {
    const file = join(tmp, 'video.mp4');
    writeFileSync(file, 'bytes');
    const dest = join(tmp, 'Videos');

    // Some implementations accept "mp4" and some require ".mp4" — both should not crash.
    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('mp4', 'ext', dest)],
    });

    const plan = planTidy(cfg);
    expect(plan).toHaveProperty('moves');
    expect(plan).toHaveProperty('skipped');
  });
});

// ---------------------------------------------------------------------------
// planTidy — rule matching: glob
// ---------------------------------------------------------------------------

describe('planTidy — rule matching: glob', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('matches a file by exact name glob', () => {
    const file = join(tmp, 'Rent Application.pdf');
    writeFileSync(file, 'dummy');
    const dest = join(tmp, 'Applications');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('Rent Application.pdf', 'glob', dest)],
    });

    const plan = planTidy(cfg);
    const move = plan.moves.find(m => m.from === file);
    expect(move).toBeDefined();
  });

  it('matches files with a wildcard glob pattern', () => {
    writeFileSync(join(tmp, 'report-2024.pdf'), 'a');
    writeFileSync(join(tmp, 'report-2025.pdf'), 'b');
    writeFileSync(join(tmp, 'invoice.pdf'), 'c');
    const dest = join(tmp, 'Reports');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('report-*.pdf', 'glob', dest)],
    });

    const plan = planTidy(cfg);
    const reportMoves = plan.moves.filter(m => m.from.includes('report-'));
    expect(reportMoves).toHaveLength(2);
    const invoiceMove = plan.moves.find(m => m.from.includes('invoice'));
    expect(invoiceMove).toBeUndefined();
  });

  it('uses first-matching rule (rules are ordered)', () => {
    const file = join(tmp, 'notes.txt');
    writeFileSync(file, 'hello');
    const dest1 = join(tmp, 'Dest1');
    const dest2 = join(tmp, 'Dest2');

    const cfg = makeConfig(tmp, {
      tidyRules: [
        makeRule('*.txt', 'glob', dest1),
        makeRule('*.txt', 'glob', dest2),
      ],
    });

    const plan = planTidy(cfg);
    const move = plan.moves.find(m => m.from === file);
    expect(move).toBeDefined();
    // First rule wins
    expect(move!.to).toBe(join(dest1, 'notes.txt'));
  });
});

// ---------------------------------------------------------------------------
// planTidy — rule matching: regex
// ---------------------------------------------------------------------------

describe('planTidy — rule matching: regex', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('matches a file by regex pattern on the basename', () => {
    const file = join(tmp, 'Screen Shot 2024-01-15.png');
    writeFileSync(file, 'dummy');
    const dest = join(tmp, 'Screenshots');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('^Screen Shot', 'regex', dest)],
    });

    const plan = planTidy(cfg);
    const move = plan.moves.find(m => m.from === file);
    expect(move).toBeDefined();
  });

  it('does not match a file that fails the regex', () => {
    const file = join(tmp, 'invoice.pdf');
    writeFileSync(file, 'dummy');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('^Screen Shot', 'regex', join(tmp, 'Screenshots'))],
    });

    const plan = planTidy(cfg);
    const move = plan.moves.find(m => m.from === file);
    expect(move).toBeUndefined();
  });

  it('matches files by ISO date pattern in regex', () => {
    writeFileSync(join(tmp, 'backup-2024-06-01.tar.gz'), 'a');
    writeFileSync(join(tmp, 'backup-2025-01-10.tar.gz'), 'b');
    writeFileSync(join(tmp, 'README.md'), 'docs');
    const dest = join(tmp, 'Backups');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('backup-\\d{4}-\\d{2}-\\d{2}', 'regex', dest)],
    });

    const plan = planTidy(cfg);
    const backupMoves = plan.moves.filter(m => m.from.includes('backup-'));
    expect(backupMoves).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// planTidy — collision skip (dest already exists)
// ---------------------------------------------------------------------------

describe('planTidy — collision skip', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('skips a move when the destination file already exists', () => {
    const file = join(tmp, 'invoice.pdf');
    writeFileSync(file, 'source');
    const dest = join(tmp, 'Documents');
    mkdirSync(dest, { recursive: true });
    // Pre-create destination file to trigger collision
    writeFileSync(join(dest, 'invoice.pdf'), 'existing content');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('.pdf', 'ext', dest)],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === file);
    expect(moved).toBeUndefined();
    const skipped = plan.skipped.find(s => s.path === file);
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toMatch(/collision|exists|conflict/i);
  });

  it('does not skip when destination does not exist yet', () => {
    const file = join(tmp, 'newfile.pdf');
    writeFileSync(file, 'new');
    const dest = join(tmp, 'NewDest');
    // Dest dir does NOT exist yet — planTidy only checks for file collision, not dir presence

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('.pdf', 'ext', dest)],
    });

    const plan = planTidy(cfg);
    const move = plan.moves.find(m => m.from === file);
    expect(move).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// applyTidy
// ---------------------------------------------------------------------------

describe('applyTidy', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('moves a file to the destination (creates dest dir if needed)', () => {
    const src = join(tmp, 'moveme.txt');
    writeFileSync(src, 'move content');
    const dest = join(tmp, 'DestDir', 'moveme.txt');

    applyTidy({
      moves: [{ from: src, to: dest, rule: 'test-rule' }],
      skipped: [],
    });

    expect(existsSync(src)).toBe(false);
    expect(existsSync(dest)).toBe(true);
  });

  it('is idempotent: silently skips if source is already gone', () => {
    const src = join(tmp, 'already-gone.txt');
    // File does not exist — should not throw
    const dest = join(tmp, 'Dest', 'already-gone.txt');

    expect(() => applyTidy({
      moves: [{ from: src, to: dest, rule: 'test-rule' }],
      skipped: [],
    })).not.toThrow();
  });

  it('is idempotent: silently skips if destination already exists', () => {
    const src = join(tmp, 'dupe.txt');
    writeFileSync(src, 'source');
    const destDir = join(tmp, 'DestDir');
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, 'dupe.txt');
    writeFileSync(dest, 'existing');

    // Should not throw and should not overwrite the destination
    expect(() => applyTidy({
      moves: [{ from: src, to: dest, rule: 'test-rule' }],
      skipped: [],
    })).not.toThrow();

    // Destination content should be unchanged (not overwritten).
    // readFileSync is imported at the top of this file from 'node:fs'.
    expect(readFileSync(dest, 'utf8')).toBe('existing');
  });

  it('creates nested destination directories (mkdir -p)', () => {
    const src = join(tmp, 'deep-file.pdf');
    writeFileSync(src, 'deep');
    const dest = join(tmp, 'a', 'b', 'c', 'deep-file.pdf');

    applyTidy({
      moves: [{ from: src, to: dest, rule: 'deep-rule' }],
      skipped: [],
    });

    expect(existsSync(dest)).toBe(true);
  });

  it('processes multiple moves in a single apply', () => {
    writeFileSync(join(tmp, 'one.txt'), '1');
    writeFileSync(join(tmp, 'two.txt'), '2');
    const dest = join(tmp, 'Multi');
    mkdirSync(dest, { recursive: true });

    applyTidy({
      moves: [
        { from: join(tmp, 'one.txt'), to: join(dest, 'one.txt'), rule: 'r' },
        { from: join(tmp, 'two.txt'), to: join(dest, 'two.txt'), rule: 'r' },
      ],
      skipped: [],
    });

    expect(existsSync(join(dest, 'one.txt'))).toBe(true);
    expect(existsSync(join(dest, 'two.txt'))).toBe(true);
    expect(existsSync(join(tmp, 'one.txt'))).toBe(false);
    expect(existsSync(join(tmp, 'two.txt'))).toBe(false);
  });

  it('applies an empty plan without errors', () => {
    expect(() => applyTidy({ moves: [], skipped: [] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// planTidy — directory rules are gated to files only
// ---------------------------------------------------------------------------

describe('planTidy — directories are never moved by file rules', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('does not move a loose top-level directory matched by a glob rule', () => {
    const dir = join(tmp, 'Contracts');
    mkdirSync(dir, { recursive: true });
    const dest = join(tmp, 'Business');
    mkdirSync(dest, { recursive: true });

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('*Contract*', 'glob', dest)],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === dir);
    expect(moved).toBeUndefined();
    const skipped = plan.skipped.find(s => s.path === dir);
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toMatch(/director/i);
  });

  it('still moves a FILE matched by the same glob rule', () => {
    const file = join(tmp, 'Service Contract.pdf');
    writeFileSync(file, 'dummy');
    const dest = join(tmp, 'Business');
    mkdirSync(dest, { recursive: true });

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('*Contract*', 'glob', dest)],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === file);
    expect(moved).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// planTidy — github protection & unsafe destinations
// ---------------------------------------------------------------------------

describe('planTidy — github protection', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('returns an empty plan when the only root is a github container', () => {
    const githubRoot = join(tmp, 'github');
    mkdirSync(githubRoot, { recursive: true });
    writeFileSync(join(githubRoot, 'loose.pdf'), 'x');

    const cfg = makeConfig(githubRoot, {
      roots: [githubRoot],
      tidyRules: [makeRule('.pdf', 'ext', join(tmp, 'Docs'))],
    });

    const plan = planTidy(cfg);
    expect(plan.moves).toHaveLength(0);
  });

  it('skips a move whose destination resolves under github/', () => {
    const file = join(tmp, 'note.md');
    writeFileSync(file, 'x');
    // Malicious/mistaken rule pointing into a github subtree.
    const dest = join(tmp, 'github', 'dev-tools');

    const cfg = makeConfig(tmp, {
      tidyRules: [makeRule('.md', 'ext', dest)],
    });

    const plan = planTidy(cfg);
    const moved = plan.moves.find(m => m.from === file);
    expect(moved).toBeUndefined();
    const skipped = plan.skipped.find(s => s.path === file);
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toMatch(/unsafe destination/i);
  });
});

// ---------------------------------------------------------------------------
// applyTidy — refuses to write into github/
// ---------------------------------------------------------------------------

describe('applyTidy — github destination guard', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('never moves a file into a github/ subtree even if the plan says so', () => {
    const src = join(tmp, 'leak.txt');
    writeFileSync(src, 'data');
    const dest = join(tmp, 'github', 'dev-tools', 'leak.txt');

    applyTidy({
      moves: [{ from: src, to: dest, rule: 'unsafe' }],
      skipped: [],
    });

    // Source untouched, destination never created.
    expect(existsSync(src)).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });
});
