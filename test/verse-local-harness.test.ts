import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const lookup = vi.hoisted(() => ({ path: '', resolve: vi.fn() }));
vi.mock('../src/core/verse/login-path.js', () => ({ resolveLoginPath: lookup.resolve }));
import { discoverLocalHarness, localHarnessForPath, localHarnessInvocation } from '../src/core/verse/local-harness.js';

let root: string;
let binary: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verse-local-harness-'));
  binary = join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  vi.stubEnv('PATH', root);
  lookup.path = root;
  lookup.resolve.mockReset().mockImplementation(async () => ({ path: lookup.path, entries: [lookup.path] }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('local tool harness metadata', () => {
  it('uses cached login PATH metadata without executing the harness', async () => {
    const found = await discoverLocalHarness();
    expect(found.executable).toBe(realpathSync(binary));
    expect(found.path.split(delimiter)).toContain(root);
    expect(localHarnessInvocation()).toEqual(found);
    expect(lookup.resolve).toHaveBeenCalledTimes(1);
  });

  it('preserves operator PATH order and resolves symlinks to executable files', () => {
    const next = join(root, 'next');
    mkdirSync(next);
    symlinkSync(binary, join(next, process.platform === 'win32' ? 'claude.exe' : 'claude'));
    const path = [next, root].join(delimiter);
    expect(localHarnessForPath(path)).toEqual({ executable: realpathSync(binary), path });
  });

  it('reads multiple Windows-delimited directories without treating the entire PATH as a filename', () => {
    const missing = join(root, 'missing');
    const path = [missing, root].join(';');
    expect(localHarnessForPath(path, ';')).toEqual({ executable: realpathSync(binary), path });
  });

  it('does not search relative PATH entries or treat directories as executable files', () => {
    const directory = join(root, 'directory');
    mkdirSync(directory);
    mkdirSync(join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude'));
    const path = ['.', directory].join(delimiter);
    expect(localHarnessForPath(path)).toEqual({ executable: null, path });
  });

  it('rechecks a discovered binary before launch instead of retaining stale readiness', async () => {
    expect((await discoverLocalHarness()).executable).not.toBeNull();
    rmSync(binary);
    expect(localHarnessInvocation().executable).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('rejects non-executable files', () => {
    chmodSync(binary, 0o600);
    expect(localHarnessForPath(root).executable).toBeNull();
  });
});
