/**
 * Proves test/setup/home-isolation-guard.ts: every mutating fs entry point is
 * blocked + recorded under a protected root, the real ~/.ashlr is protected in
 * this very worker, and a SWALLOWED violation still fails the test (wiring
 * check in a child vitest run).
 *
 * Safety of the real-root checks: they use operations that are harmless even
 * if the guard were broken (utimes/unlink/rm of a path that does not exist →
 * ENOENT, no side effect). The guard is proven by the EACCES it returns first.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { writeFile as writeFileP, mkdir as mkdirP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNoRealHomeWrites,
  formatViolations,
  homeIsolationGuardState,
  installFsWriteGuard,
  isWriteOpenFlag,
  protectedRootFor,
  resolveProtectedRoots,
  type HomeGuardViolation,
} from './home-isolation-guard.js';

const REPO_ROOT = resolve(__dirname, '..', '..');

function expectBlocked(fn: () => unknown): NodeJS.ErrnoException {
  try {
    fn();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    expect(e.code).toBe('EACCES');
    expect(e.message).toMatch(/HOME isolation guard blocked/);
    return e;
  }
  throw new Error('expected the HOME isolation guard to block this call');
}

describe('process-wide guard (installed by setupFiles)', () => {
  it('protects the REAL ~/.ashlr and never the isolated worker HOME', () => {
    const { roots } = homeIsolationGuardState();
    const realHome = process.env['ASHLR_VITEST_REAL_HOME'];
    expect(realHome).toBeTruthy();
    expect(roots).toContain(join(realHome!, '.ashlr'));
    const workerHome = process.env['HOME']!;
    for (const root of roots) {
      expect(workerHome.startsWith(root)).toBe(false);
      expect(protectedRootFor(join(workerHome, '.ashlr', 'daemon.json'), 'write', roots)).toBeNull();
    }
  });

  it('blocks real-root writes through every import style and records each one', async () => {
    const root = join(process.env['ASHLR_VITEST_REAL_HOME']!, '.ashlr');
    // Paths that do not exist: if the guard were absent these would fail with
    // ENOENT and change nothing on disk. EACCES proves the guard ran first.
    const ghost = join(root, `__vitest-home-guard-canary-${process.pid}__`, 'never');
    const state = homeIsolationGuardState();
    const before = state.violations.length;

    expectBlocked(() => fs.utimesSync(ghost, new Date(), new Date())); // namespace import
    expectBlocked(() => fs.unlinkSync(ghost));
    await expect(fs.promises.rm(ghost)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(
      new Promise<void>((res, rej) => fs.unlink(ghost, (err) => (err ? rej(err) : res()))),
    ).rejects.toMatchObject({ code: 'EACCES' });

    const recorded = state.violations.splice(before);
    expect(recorded.map((v) => v.op)).toEqual(['utimes', 'unlink', 'rm', 'unlink']);
    for (const v of recorded) {
      expect(v.root).toBe(root);
      expect(v.test).toContain('home-isolation-guard.test.ts > process-wide guard');
    }
    expect(existsSync(join(root, `__vitest-home-guard-canary-${process.pid}__`))).toBe(false);
    // Drained above, so this test's own afterEach stays green.
    expect(() => assertNoRealHomeWrites()).not.toThrow();
  });

  it('assertNoRealHomeWrites drains and throws a readable report', () => {
    const state = homeIsolationGuardState();
    const v: HomeGuardViolation = { op: 'writeFile', path: '/x/.ashlr/daemon.json', root: '/x/.ashlr', test: 'a > b' };
    state.violations.push(v);
    expect(() => assertNoRealHomeWrites()).toThrow(/1 write\(s\) targeted the REAL ~\/\.ashlr[\s\S]*fs\.writeFile\('\/x\/\.ashlr\/daemon\.json'\)[\s\S]*\[a > b\]/);
    expect(state.violations).toHaveLength(0);
    expect(formatViolations([v, v])).toMatch(/^HOME isolation guard: 2 write/);
  });

  it('computes roots from the captured real home and the passwd home, minus the worker home', () => {
    const workerHome = process.env['HOME']!;
    const roots = resolveProtectedRoots({
      ASHLR_VITEST_REAL_HOME: '/nonexistent-real-home',
      ASHLR_VITEST_WORKER_HOME: workerHome,
    });
    expect(roots).toContain(join('/nonexistent-real-home', '.ashlr'));
    // A "real" home that CONTAINS the worker home (ambient HOME already a tmp
    // dir) must not protect the worker's own state.
    const nested = resolveProtectedRoots({
      ASHLR_VITEST_REAL_HOME: workerHome,
      ASHLR_VITEST_WORKER_HOME: join(workerHome, '.ashlr', 'nested-worker'),
    });
    expect(nested).not.toContain(join(workerHome, '.ashlr'));
  });
});

describe('installFsWriteGuard against a fake protected home', () => {
  let base: string;
  let fakeRoot: string;
  let outside: string;
  let seen: HomeGuardViolation[];
  let uninstall: (() => void) | null;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-home-guard-')));
    fakeRoot = join(base, 'fake-home', '.ashlr');
    outside = join(base, 'outside');
    mkdirSync(fakeRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(fakeRoot, 'existing.json'), '{"v":1}');
    seen = [];
    uninstall = installFsWriteGuard(() => [fakeRoot], (v) => seen.push(v)).uninstall;
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    rmSync(base, { recursive: true, force: true });
  });

  it('blocks sync, callback, promise, ESM-named and stream writes', async () => {
    const target = join(fakeRoot, 'daemon.json');
    expectBlocked(() => writeFileSync(target, 'x')); // ESM named binding (syncBuiltinESMExports)
    expectBlocked(() => appendFileSync(target, 'x'));
    expectBlocked(() => fs.mkdirSync(join(fakeRoot, 'a', 'b'), { recursive: true }));
    expectBlocked(() => fs.mkdtempSync(join(fakeRoot, 'tmp-')));
    expectBlocked(() => fs.createWriteStream(target));
    expectBlocked(() => fs.copyFileSync(join(outside, '..', 'outside'), target));
    await expect(writeFileP(target, 'x')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(mkdirP(join(fakeRoot, 'p'))).rejects.toMatchObject({ code: 'EACCES' });
    await expect(
      new Promise<void>((res, rej) => fs.writeFile(target, 'x', (err) => (err ? rej(err) : res()))),
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(fakeRoot, 'a'))).toBe(false);
    expect(seen.map((v) => v.op)).toEqual([
      'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'createWriteStream', 'copyFile',
      'writeFile', 'mkdir', 'writeFile',
    ]);
  });

  it('allows reads and read-only opens, blocks write-mode opens', async () => {
    const existing = join(fakeRoot, 'existing.json');
    expect(readFileSync(existing, 'utf8')).toBe('{"v":1}');
    const fd = fs.openSync(existing, 'r');
    fs.closeSync(fd);
    const handle = await fs.promises.open(existing);
    await handle.close();
    expectBlocked(() => fs.openSync(existing, 'r+'));
    expectBlocked(() => fs.openSync(existing, fs.constants.O_WRONLY | fs.constants.O_APPEND));
    await expect(fs.promises.open(existing, 'a')).rejects.toMatchObject({ code: 'EACCES' });
    expect(readFileSync(existing, 'utf8')).toBe('{"v":1}');
    expect(isWriteOpenFlag(undefined)).toBe(false);
    expect(isWriteOpenFlag('rs')).toBe(false);
    expect(isWriteOpenFlag('wx')).toBe(true);
    expect(isWriteOpenFlag(fs.constants.O_RDONLY)).toBe(false);
    expect(isWriteOpenFlag({})).toBe(true); // unknown shape fails closed
  });

  it('blocks moving state in or out, deleting it, and deleting an ANCESTOR of it', () => {
    const existing = join(fakeRoot, 'existing.json');
    const free = join(outside, 'free.json');
    writeFileSync(free, 'ok');
    expectBlocked(() => fs.renameSync(free, join(fakeRoot, 'moved.json')));
    expectBlocked(() => fs.renameSync(existing, join(outside, 'stolen.json')));
    expectBlocked(() => fs.unlinkSync(existing));
    expectBlocked(() => fs.rmSync(join(base, 'fake-home'), { recursive: true, force: true }));
    expectBlocked(() => fs.rmSync(base, { recursive: true, force: true }));
    expectBlocked(() => fs.chmodSync(existing, 0o600));
    expectBlocked(() => fs.symlinkSync(free, join(fakeRoot, 'link')));
    expect(readFileSync(existing, 'utf8')).toBe('{"v":1}');
    expect(existsSync(free)).toBe(true);
  });

  it('sees through a symlink that launders a write into the protected root', () => {
    const link = join(outside, 'innocent');
    symlinkSync(fakeRoot, link);
    expectBlocked(() => writeFileSync(join(link, 'daemon.json'), 'x'));
    expectBlocked(() => fs.mkdirSync(join(link, 'deep', 'er'), { recursive: true }));
    expect(existsSync(join(fakeRoot, 'daemon.json'))).toBe(false);
    // Removing the LINK itself does not touch the protected tree.
    fs.unlinkSync(link);
    expect(existsSync(join(fakeRoot, 'existing.json'))).toBe(true);
  });

  it('leaves everything outside the protected root alone and restores originals on uninstall', () => {
    const wrapped = fs.writeFileSync;
    writeFileSync(join(outside, 'ok.txt'), 'fine');
    fs.renameSync(join(outside, 'ok.txt'), join(outside, 'ok2.txt'));
    fs.rmSync(join(outside, 'ok2.txt'));
    expect(seen).toEqual([]);
    uninstall!();
    uninstall = null;
    expect(fs.writeFileSync).not.toBe(wrapped);
    // Back to the process-wide guard only: the fake root is writable again.
    writeFileSync(join(fakeRoot, 'after.json'), 'x');
    expect(readFileSync(join(fakeRoot, 'after.json'), 'utf8')).toBe('x');
  });

  it('protectedRootFor handles relative paths, file URLs and case folding', () => {
    expect(protectedRootFor(join(fakeRoot, 'x'), 'write', [fakeRoot])).toBe(fakeRoot);
    expect(protectedRootFor(`${fakeRoot}-sibling/x`, 'write', [fakeRoot])).toBeNull();
    expect(protectedRootFor(join(base, 'fake-home'), 'write', [fakeRoot])).toBeNull();
    expect(protectedRootFor(join(base, 'fake-home'), 'remove', [fakeRoot])).toBe(fakeRoot);
    if (process.platform === 'darwin') {
      expect(protectedRootFor(join(fakeRoot.toUpperCase(), 'x'), 'write', [fakeRoot])).toBe(fakeRoot);
    }
    const url = new URL(`file://${join(fakeRoot, 'u.json')}`);
    expectBlocked(() => writeFileSync(url, 'x'));
  });
});

describe('wiring: a swallowed violation still fails the test run', () => {
  it('fails a child vitest run whose code catches the guard error', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-home-guard-wiring-')));
    try {
      // `globals: true` so the fixture (outside the repo) needs no `vitest`
      // import resolution; the setup files resolve theirs from the repo.
      const fixture = join(dir, 'swallow.fixture.test.ts');
      writeFileSync(
        fixture,
        [
          "import { utimesSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const ghost = join(process.env.ASHLR_VITEST_REAL_HOME!, '.ashlr', '__vitest-home-guard-wiring__', 'x');",
          '// A "never throws" writer: swallows every error, like the ledgers do.',
          'function silentWrite(): void { try { utimesSync(ghost, new Date(), new Date()); } catch { /* swallowed */ } }',
          'silentWrite(); // at module load',
          "it('leaks quietly', () => { silentWrite(); expect(true).toBe(true); });",
          "it('stays clean', () => { expect(1).toBe(1); });",
          '',
        ].join('\n'),
      );
      const config = join(dir, 'vitest.fixture.config.mjs');
      writeFileSync(
        config,
        `export default { test: { root: ${JSON.stringify(dir)}, include: ['*.fixture.test.ts'], pool: 'forks', globals: true,
  setupFiles: [${JSON.stringify(join(REPO_ROOT, 'test/setup/home.ts'))}, ${JSON.stringify(join(REPO_ROOT, 'test/setup/home-isolation-guard.ts'))}] } };\n`,
      );
      const result = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', config, '--root', dir],
        { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, timeout: 90_000 },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(1);
      expect(output).toMatch(/HOME isolation guard: 2 write\(s\) targeted the REAL ~\/\.ashlr/);
      expect(output).toMatch(/module load \/ hook outside a test/);
      expect(output).toMatch(/swallow\.fixture\.test\.ts > leaks quietly/);
      expect(output).toMatch(/1 failed \| 1 passed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
