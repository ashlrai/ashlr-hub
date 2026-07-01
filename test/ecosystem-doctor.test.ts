import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

import { runEcosystemDoctor } from '../src/core/ecosystem/doctor.js';
import { cmdEcosystem } from '../src/cli/ecosystem.js';

function spawnResult(stdout: string, status = 0, stderr = ''): unknown {
  return { stdout, stderr, status, error: undefined };
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ashlr-ecosystem-doctor-'));
}

function makeRepo(root: string, name: string, files: Record<string, string>): string {
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(repo, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return repo;
}

function installGitMock(): void {
  mocks.spawnSync.mockImplementation((cmd: string, args: string[], options: { env?: Record<string, string> }) => {
    expect(cmd).toBe('git');
    expect(options.env?.GIT_OPTIONAL_LOCKS).toBe('0');
    const gitArgs = args.slice(2);
    const action = gitArgs.join(' ');
    if (action === 'rev-parse --is-inside-work-tree') return spawnResult('true\n');
    if (action === 'status --porcelain=v1 --branch --untracked-files=normal') return spawnResult('## main...origin/main\n');
    if (action === 'log -1 --format=%cI') return spawnResult('2026-06-01T00:00:00+00:00\n');
    return spawnResult('', 1, `unexpected git args: ${action}`);
  });
}

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  let stdout = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .then((result) => ({ result, stdout }))
    .finally(() => {
      process.stdout.write = original;
    });
}

let roots: string[] = [];

beforeEach(() => {
  roots = [];
  mocks.spawnSync.mockReset();
  installGitMock();
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('runEcosystemDoctor', () => {
  it('scans immediate sibling repos and reports git/package/docs health', async () => {
    const root = makeRoot();
    roots.push(root);
    makeRepo(root, 'healthy', {
      'package.json': JSON.stringify({ name: 'healthy', version: '1.0.0', scripts: { test: 'vitest' } }),
      'README.md': '# Healthy\n',
    });
    makeRepo(root, 'broken-package', {
      'package.json': '{ nope',
    });

    const report = await runEcosystemDoctor({ root });

    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.root).toBe(root);
    expect(report.repos.map((repo) => repo.name)).toEqual(['broken-package', 'healthy']);
    expect(report.summary.repos).toBe(2);
    expect(report.summary.fail).toBe(1);
    expect(report.checks.some((check) => check.id === 'package' && check.status === 'fail')).toBe(true);
    expect(report.checks.some((check) => check.id === 'docs' && check.status === 'warn')).toBe(true);
  });

  it('returns a warning-only report for an empty root', async () => {
    const root = makeRoot();
    roots.push(root);

    const report = await runEcosystemDoctor({ root });

    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(1);
    expect(report.repos).toEqual([]);
  });

  it('deep mode remains read-only: only bounded git probes, no package managers or scripts', async () => {
    const root = makeRoot();
    roots.push(root);
    makeRepo(root, 'deep-repo', {
      'package.json': JSON.stringify({
        name: 'deep-repo',
        version: '1.0.0',
        dependencies: { leftpad: '1.0.0' },
        scripts: { build: 'tsc', test: 'vitest' },
      }),
      'README.md': '# Deep repo\n',
    });

    await runEcosystemDoctor({ root, deep: true });

    const calls = mocks.spawnSync.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [cmd, args] of calls) {
      expect(cmd).toBe('git');
      expect(args).not.toContain('npm');
      expect(args).not.toContain('pnpm');
      expect(args).not.toContain('yarn');
      expect(args).not.toContain('run');
      expect(args).not.toContain('build');
      expect(args).not.toContain('test');
    }
  });
});

describe('cmdEcosystem', () => {
  it('emits the requested JSON shape and exits 0 when there are warnings but no failures', async () => {
    const root = makeRoot();
    roots.push(root);
    makeRepo(root, 'warn-only', {
      'package.json': JSON.stringify({ name: 'warn-only', version: '1.0.0' }),
    });

    const { result: exitCode, stdout } = await captureStdout(() =>
      cmdEcosystem(['doctor', '--json', '--root', root]),
    );
    const json = JSON.parse(stdout) as {
      generatedAt: string;
      root: string;
      summary: { fail: number; warn: number; repos: number };
      checks: unknown[];
      repos: unknown[];
    };

    expect(exitCode).toBe(0);
    expect(Object.keys(json)).toEqual(['generatedAt', 'root', 'summary', 'checks', 'repos']);
    expect(json.root).toBe(root);
    expect(json.summary.fail).toBe(0);
    expect(json.summary.warn).toBeGreaterThan(0);
    expect(json.summary.repos).toBe(1);
    expect(Array.isArray(json.checks)).toBe(true);
    expect(Array.isArray(json.repos)).toBe(true);
  });
});
