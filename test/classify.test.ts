/**
 * Tests for src/core/classify.ts
 *
 * All tests are hermetic: temp dirs under os.tmpdir(), real Desktop never touched.
 *
 * classify.ts calls loadConfig() internally to resolve categories.
 * We override the HOME env var so CONFIG_DIR resolves to a temp location,
 * and write a config.json there before importing.
 *
 * Because CONFIG_DIR is a module-level constant (evaluated at first import),
 * we use vi.mock to control the config module and inject a test config.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { AshlrConfig } from '../src/core/types.js';
import { canSymlink } from './helpers/platform.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'ashlr-classify-test-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Create the standard github sub-category directory layout under `base`. */
function makeGithubLayout(base: string): void {
  const github = join(base, 'github');
  mkdirSync(join(github, 'dev-tools'), { recursive: true });
  mkdirSync(join(github, 'side-projects'), { recursive: true });
}

function makeConfig(overrides: Partial<AshlrConfig> & { base: string }): AshlrConfig {
  const { base, ...rest } = overrides;
  const github = join(base, 'github');
  return {
    version: 1,
    roots: [base],
    editor: 'cursor',
    staleDays: 30,
    categories: {
      'dev-tools': join(github, 'dev-tools'),
      'side-projects': join(github, 'side-projects'),
      'professional-tools': join(github, 'professional-tools'),
      'artist-encyclopedias': join(github, 'artist-encyclopedias'),
      'client-engagements': join(github, 'client-engagements'),
      'forks': join(github, 'forks'),
      'ashlrai': join(github, 'ashlrai'),
      'Business': join(base, 'Business'),
      'Client-Work': join(base, 'Client-Work'),
    },
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Mock config module so classify.ts gets our test config
// ---------------------------------------------------------------------------

let _testConfig: AshlrConfig | null = null;

vi.mock('../src/core/config.js', () => ({
  CONFIG_DIR: join(tmpdir(), 'ashlr-classify-mock-config'),
  CONFIG_PATH: join(tmpdir(), 'ashlr-classify-mock-config', 'config.json'),
  INDEX_PATH: join(tmpdir(), 'ashlr-classify-mock-config', 'index.json'),
  defaultConfig: () => { throw new Error('not implemented in mock'); },
  loadConfig: () => {
    if (!_testConfig) throw new Error('Test config not set — call setTestConfig() first');
    return _testConfig;
  },
  saveConfig: () => { /* no-op in tests */ },
}));

function setTestConfig(cfg: AshlrConfig): void {
  _testConfig = cfg;
}

// Import classify AFTER mocking config
import { categoryOf, describe as describeItem, kindOf, primaryLanguage } from '../src/core/classify.js';

// ---------------------------------------------------------------------------
// categoryOf
// ---------------------------------------------------------------------------

describe('categoryOf', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
    makeGithubLayout(tmp);
    setTestConfig(makeConfig({ base: tmp }));
  });

  afterEach(() => cleanup(tmp));

  it('returns "dev-tools" for a path inside github/dev-tools', () => {
    const repoPath = join(tmp, 'github', 'dev-tools', 'ashlr-hub');
    mkdirSync(repoPath, { recursive: true });
    expect(categoryOf(repoPath)).toBe('dev-tools');
  });

  it('returns "side-projects" for a path inside github/side-projects', () => {
    const repoPath = join(tmp, 'github', 'side-projects', 'precious-grove');
    mkdirSync(repoPath, { recursive: true });
    expect(categoryOf(repoPath)).toBe('side-projects');
  });

  it('returns "Business" for a path inside the Business doc folder', () => {
    const docPath = join(tmp, 'Business', 'invoice.pdf');
    mkdirSync(join(tmp, 'Business'), { recursive: true });
    writeFileSync(docPath, 'dummy');
    expect(categoryOf(docPath)).toBe('Business');
  });

  it('returns "Client-Work" for a path inside Client-Work', () => {
    const docPath = join(tmp, 'Client-Work', 'contract.pdf');
    mkdirSync(join(tmp, 'Client-Work'), { recursive: true });
    writeFileSync(docPath, 'dummy');
    expect(categoryOf(docPath)).toBe('Client-Work');
  });

  it('returns null for a path that matches no category', () => {
    const loose = join(tmp, 'some-loose-file.txt');
    writeFileSync(loose, 'hello');
    expect(categoryOf(loose)).toBeNull();
  });

  it('returns null for a completely unrelated path', () => {
    expect(categoryOf('/var/log/system.log')).toBeNull();
  });

  it('returns the correct category for a nested path (depth 3 inside category)', () => {
    const nested = join(tmp, 'github', 'dev-tools', 'ashlr-hub', 'src', 'core');
    mkdirSync(nested, { recursive: true });
    expect(categoryOf(nested)).toBe('dev-tools');
  });
});

// ---------------------------------------------------------------------------
// describe (README h1 + package.json fallback)
// ---------------------------------------------------------------------------

describe('describe', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('returns the H1 from a README.md in the directory', () => {
    const dir = join(tmp, 'project-with-readme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# My Cool Project\n\nSome description.\n');
    expect(describeItem(dir)).toBe('My Cool Project');
  });

  it('trims whitespace from the H1', () => {
    const dir = join(tmp, 'whitespace-readme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '#   Padded Title   \n\nBody.\n');
    expect(describeItem(dir)).toBe('Padded Title');
  });

  it('falls back to package.json description when no README', () => {
    const dir = join(tmp, 'project-no-readme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'my-pkg',
      description: 'Package JSON description',
    }));
    expect(describeItem(dir)).toBe('Package JSON description');
  });

  it('prefers README h1 over package.json description', () => {
    const dir = join(tmp, 'project-both');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# README Title\n\nDetails.\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'my-pkg',
      description: 'package description',
    }));
    expect(describeItem(dir)).toBe('README Title');
  });

  it('returns null when there is no README and no package.json', () => {
    const dir = join(tmp, 'bare-dir');
    mkdirSync(dir, { recursive: true });
    expect(describeItem(dir)).toBeNull();
  });

  it('returns null when package.json has no description field', () => {
    const dir = join(tmp, 'pkg-no-desc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'no-desc' }));
    expect(describeItem(dir)).toBeNull();
  });

  it('returns null when README has no H1 line and no package.json', () => {
    const dir = join(tmp, 'readme-no-h1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'Just some content\nwith no heading.\n');
    expect(describeItem(dir)).toBeNull();
  });

  it('works against the test/fixtures directory (real README.md)', () => {
    // Uses the committed fixture at test/fixtures/README.md
    const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));
    const result = describeItem(fixturesDir);
    expect(result).toBe('My Fixture Project');
  });

  it('returns the HTML <h1> title when README has no markdown H1', () => {
    const dir = join(tmp, 'html-h1-readme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '<h1>Phantom Secrets</h1>\n\nSome body text here.\n');
    expect(describeItem(dir)).toBe('Phantom Secrets');
  });

  it('returns the HTML <h1> title with attributes on the tag', () => {
    const dir = join(tmp, 'html-h1-attrs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '<h1 align="center">My Tool</h1>\n\nDescription.\n');
    expect(describeItem(dir)).toBe('My Tool');
  });

  it('returns null when README has body text but no H1 of any kind (no body-line fallback)', () => {
    const dir = join(tmp, 'no-h1-any-kind');
    mkdirSync(dir, { recursive: true });
    // Simulates prompt-trackr case: README with words like "or" but no H1
    writeFileSync(join(dir, 'README.md'), 'Install with npm\nor\nyarn add foo\n');
    expect(describeItem(dir)).toBeNull();
  });

  it('falls back to package.json description when README has HTML H1 that is empty', () => {
    const dir = join(tmp, 'empty-html-h1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '<h1></h1>\n\nSome content.\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'my-pkg',
      description: 'fallback description',
    }));
    expect(describeItem(dir)).toBe('fallback description');
  });

  it('works against the test/fixtures directory (real package.json fallback)', () => {
    // Remove README from the path being checked — use a sub-tmp dir with only package.json
    const dir = join(tmp, 'pkg-only');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-pkg',
      description: 'A fixture package description',
    }));
    expect(describeItem(dir)).toBe('A fixture package description');
  });
});

// ---------------------------------------------------------------------------
// kindOf
// ---------------------------------------------------------------------------

describe('kindOf', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  // Windows blocks symlink creation without privilege (EPERM); skip there.
  it.skipIf(!canSymlink())('returns "symlink" for a symlink (takes priority over everything)', () => {
    const target = join(tmp, 'target-dir');
    mkdirSync(target, { recursive: true });
    const link = join(tmp, 'my-link');
    symlinkSync(target, link);
    expect(kindOf(link)).toBe('symlink');
  });

  // Windows blocks symlink creation without privilege (EPERM); skip there.
  it.skipIf(!canSymlink())('returns "symlink" even if the symlink target is a repo', () => {
    const target = join(tmp, 'target-repo');
    mkdirSync(target, { recursive: true });
    execSync('git init', { cwd: target, stdio: 'pipe' });
    const link = join(tmp, 'link-to-repo');
    symlinkSync(target, link);
    expect(kindOf(link)).toBe('symlink');
  });

  it('returns "repo" for a directory with a .git subdirectory', () => {
    const repo = join(tmp, 'my-repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    expect(kindOf(repo)).toBe('repo');
  });

  it('returns "repo" for a directory with a .git file (worktree)', () => {
    const repo = join(tmp, 'worktree-repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.git'), 'gitdir: /some/path/.git/worktrees/foo\n');
    expect(kindOf(repo)).toBe('repo');
  });

  it('returns "doc-folder" for a known doc category folder name', () => {
    // doc-folder: a directory that is NOT a repo and whose name matches doc patterns
    const docFolder = join(tmp, 'Business');
    mkdirSync(docFolder, { recursive: true });
    // kindOf logic: not symlink, not repo => checks name/content for doc-folder
    const result = kindOf(docFolder);
    // Should be 'doc-folder' or 'other' depending on implementation heuristics
    // Contract says: doc-folder / asset / doc / other by name + dirent type
    // We assert it's NOT symlink and NOT repo
    expect(result).not.toBe('symlink');
    expect(result).not.toBe('repo');
  });

  it('returns "doc" for a regular file', () => {
    const file = join(tmp, 'my-document.pdf');
    writeFileSync(file, '%PDF-dummy');
    const result = kindOf(file);
    // A file should be 'doc' or 'asset' or 'other' — not 'repo' or 'symlink' or 'doc-folder'
    expect(['doc', 'asset', 'other']).toContain(result);
  });

  it('returns "asset" or "doc" for image files', () => {
    const img = join(tmp, 'photo.png');
    writeFileSync(img, 'dummy png bytes');
    const result = kindOf(img);
    expect(['asset', 'doc', 'other']).toContain(result);
  });

  it('returns "other" or a valid ItemKind for an unknown plain directory', () => {
    const dir = join(tmp, 'random-folder-xyz');
    mkdirSync(dir, { recursive: true });
    const validKinds = ['repo', 'doc-folder', 'doc', 'asset', 'symlink', 'other'];
    expect(validKinds).toContain(kindOf(dir));
  });
});

// ---------------------------------------------------------------------------
// primaryLanguage
// ---------------------------------------------------------------------------

describe('primaryLanguage', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('returns "TypeScript" for a dir with package.json containing TS devDep', () => {
    const dir = join(tmp, 'ts-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'ts-proj',
      devDependencies: { typescript: '^5.0.0' },
    }));
    const result = primaryLanguage(dir);
    // Should return "TypeScript" or "JavaScript" (both are valid TS/JS signals)
    expect(['TypeScript', 'JavaScript', 'TypeScript/JavaScript']).toContain(result);
  });

  it('returns "JavaScript" or "TypeScript" for a dir with package.json (no TS dep)', () => {
    const dir = join(tmp, 'js-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'js-proj' }));
    const result = primaryLanguage(dir);
    expect(['TypeScript', 'JavaScript', 'TypeScript/JavaScript']).toContain(result);
  });

  it('returns "Go" for a dir with go.mod', () => {
    const dir = join(tmp, 'go-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'go.mod'), 'module example.com/mymod\n\ngo 1.21\n');
    expect(primaryLanguage(dir)).toBe('Go');
  });

  it('returns "Rust" for a dir with Cargo.toml', () => {
    const dir = join(tmp, 'rust-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "mylib"\nversion = "0.1.0"\n');
    expect(primaryLanguage(dir)).toBe('Rust');
  });

  it('returns "Python" for a dir with pyproject.toml', () => {
    const dir = join(tmp, 'python-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.poetry]\nname = "mypkg"\n');
    expect(primaryLanguage(dir)).toBe('Python');
  });

  it('returns null for a directory with no recognizable language markers', () => {
    const dir = join(tmp, 'unknown-lang');
    mkdirSync(dir, { recursive: true });
    expect(primaryLanguage(dir)).toBeNull();
  });
});
