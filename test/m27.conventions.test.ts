/**
 * M27 conventions probe tests — hermetic, tmp git repos. NEVER touches the real
 * ~/.ashlr or the real portfolio.
 *
 * Invariants under test:
 *   - READ-ONLY: probeConventions performs only FS reads; a tmp repo's tree is
 *     byte-identical (shasum stable) before/after a probe, and `git status
 *     --porcelain` stays clean.
 *   - Deterministic: a fully-equipped repo => every finding ok:true; a bare repo
 *     => the expected core findings ok:false.
 *   - Bounded / never-throws: a missing path returns [] (no throw).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { probeConventions } from '../src/core/quality/conventions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function mkRepo(name: string): string {
  const repo = path.join(tmpRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  return repo;
}

function write(repo: string, rel: string, content: string): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

/** sha256 over the sorted (relpath, bytes) of every tracked + untracked file. */
function treeHash(repo: string): string {
  const h = createHash('sha256');
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        h.update(path.relative(repo, full));
        h.update(fs.readFileSync(full));
      }
    }
  };
  walk(repo);
  return h.digest('hex');
}

function findingMap(repo: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of probeConventions(repo)) out[f.key] = f.ok;
  return out;
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm27-conv-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('probeConventions — fully equipped repo', () => {
  it('reports every probed convention as ok:true', () => {
    const repo = mkRepo('full');
    write(repo, 'README.md', 'x'.repeat(500)); // > THIN_README_BYTES
    write(repo, 'LICENSE', 'MIT License\n\nCopyright (c) 2026\n');
    write(repo, 'package-lock.json', '{"lockfileVersion":3}\n');
    write(repo, '.gitignore', 'node_modules\ndist\n');
    write(repo, 'tests/example.test.ts', 'export {};\n');
    write(repo, '.github/workflows/ci.yml', 'name: CI\n');
    write(
      repo,
      'package.json',
      JSON.stringify(
        {
          name: 'full',
          license: 'MIT',
          repository: { type: 'git', url: 'https://example.com/full.git' },
          scripts: { test: 'vitest run' },
        },
        null,
        2,
      ) + '\n',
    );

    const findings = probeConventions(repo);
    // README, license, lockfile, gitignore, testdir, ci, pkg-license, pkg-repository
    expect(findings.length).toBe(8);
    for (const f of findings) {
      expect(f.ok, `expected ${f.key} ok`).toBe(true);
      expect(typeof f.weight).toBe('number');
      expect(typeof f.label).toBe('string');
      expect(typeof f.detail).toBe('string');
    }
  });

  it('treats a package.json "test" script as the test signal even without a test dir', () => {
    const repo = mkRepo('script-only');
    write(repo, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }) + '\n');
    expect(findingMap(repo)['testdir']).toBe(true);
  });
});

describe('probeConventions — bare repo', () => {
  it('reports the expected core conventions as missing (ok:false)', () => {
    const repo = mkRepo('bare');
    const m = findingMap(repo);
    expect(m['readme']).toBe(false);
    expect(m['license']).toBe(false);
    expect(m['lockfile']).toBe(false);
    expect(m['gitignore']).toBe(false);
    expect(m['testdir']).toBe(false);
    expect(m['ci']).toBe(false);
    // No package.json => the npm-specific metadata probes are NOT emitted.
    expect('pkg-license' in m).toBe(false);
    expect('pkg-repository' in m).toBe(false);
  });

  it('flags a thin README and a package.json missing license/repository', () => {
    const repo = mkRepo('thin');
    write(repo, 'README.md', 'tiny'); // < THIN_README_BYTES
    write(repo, 'package.json', JSON.stringify({ name: 'thin' }) + '\n');
    const m = findingMap(repo);
    expect(m['readme']).toBe(false); // present but thin
    expect(m['pkg-license']).toBe(false);
    expect(m['pkg-repository']).toBe(false);
  });
});

describe('probeConventions — safety', () => {
  it('never mutates the repo working tree (shasum + git status stable)', () => {
    const repo = mkRepo('readonly');
    write(repo, 'README.md', 'x'.repeat(400));
    write(repo, 'package.json', JSON.stringify({ name: 'ro', scripts: { test: 'vitest' } }) + '\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

    const before = treeHash(repo);
    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString();

    probeConventions(repo);
    probeConventions(repo); // idempotent — run twice

    const after = treeHash(repo);
    const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString();

    expect(after).toBe(before);
    expect(statusAfter).toBe(statusBefore);
    expect(statusAfter.trim()).toBe(''); // clean tree
  });

  it('never throws for a non-existent path (reports everything absent)', () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    expect(() => probeConventions(missing)).not.toThrow();
    const m = findingMap(missing);
    // existsSync is false for every probe target => all core findings ok:false.
    expect(m['readme']).toBe(false);
    expect(m['license']).toBe(false);
    expect(m['lockfile']).toBe(false);
    expect(m['gitignore']).toBe(false);
    expect(m['testdir']).toBe(false);
    expect(m['ci']).toBe(false);
    // No package.json on a missing path => no npm-metadata probes.
    expect('pkg-license' in m).toBe(false);
  });

  it('is deterministic — repeated probes yield identical results', () => {
    const repo = mkRepo('determinism');
    write(repo, 'README.md', 'x'.repeat(500));
    write(repo, '.gitignore', 'node_modules\n');
    const a = probeConventions(repo);
    const b = probeConventions(repo);
    expect(b).toEqual(a);
  });
});
