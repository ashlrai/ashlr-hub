import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDaemonServiceSourceClean,
  inspectDaemonSourceCheckout,
} from '../src/core/daemon/release-source.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-daemon-release-source-')));
  tempDirs.push(dir);
  return dir;
}

function initCheckout(): { root: string; binPath: string } {
  const root = tempDir();
  const binDir = path.join(root, 'bin');
  const binPath = path.join(binDir, 'ashlr');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n', 'utf8');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', 'bin/ashlr']);
  execFileSync('git', [
    '-C', root,
    '-c', 'user.name=Ashlr Test',
    '-c', 'user.email=ashlr-test@example.invalid',
    'commit', '-qm', 'fixture',
  ]);
  return { root, binPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('daemon release source inspection', () => {
  it('accepts a clean Git-backed release checkout', () => {
    const { root, binPath } = initCheckout();

    expect(inspectDaemonSourceCheckout(binPath)).toEqual({ state: 'clean', root });
    expect(() => assertDaemonServiceSourceClean(binPath)).not.toThrow();
  });

  it.each([
    ['unstaged', ({ binPath }: { root: string; binPath: string }) => fs.appendFileSync(binPath, '// dirty\n')],
    ['staged', ({ root, binPath }: { root: string; binPath: string }) => {
      fs.appendFileSync(binPath, '// staged\n');
      execFileSync('git', ['-C', root, 'add', 'bin/ashlr']);
    }],
    ['untracked', ({ root }: { root: string; binPath: string }) => fs.writeFileSync(path.join(root, 'untracked.txt'), 'dirty\n')],
  ])('rejects a checkout with %s changes', (_kind, mutate) => {
    const checkout = initCheckout();
    mutate(checkout);

    expect(inspectDaemonSourceCheckout(checkout.binPath)).toEqual({ state: 'dirty', root: checkout.root });
    expect(() => assertDaemonServiceSourceClean(checkout.binPath)).toThrow(
      `Refusing to install daemon service from dirty Git checkout: ${checkout.root}`,
    );
  });

  it('allows a packaged executable without a Git checkout ancestor', () => {
    const root = tempDir();
    const binPath = path.join(root, 'bin', 'ashlr');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '#!/usr/bin/env node\n', 'utf8');

    expect(inspectDaemonSourceCheckout(binPath)).toEqual({ state: 'not-git' });
    expect(() => assertDaemonServiceSourceClean(binPath)).not.toThrow();
  });

  it('does not inherit dirtiness from a repository containing a packaged install', () => {
    const host = initCheckout();
    const packageRoot = path.join(host.root, 'node_modules', '@ashlr', 'hub');
    const binPath = path.join(packageRoot, 'bin', 'ashlr');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '#!/usr/bin/env node\n', 'utf8');

    expect(inspectDaemonSourceCheckout(binPath)).toEqual({ state: 'not-git' });
  });

  it('follows an executable symlink back to its dirty source checkout', () => {
    const checkout = initCheckout();
    fs.appendFileSync(checkout.binPath, '// dirty\n');
    const linkedBin = path.join(tempDir(), 'ashlr');
    fs.symlinkSync(checkout.binPath, linkedBin);

    expect(inspectDaemonSourceCheckout(linkedBin)).toEqual({ state: 'dirty', root: checkout.root });
  });

  it('fails closed when an owned Git checkout cannot be inspected', () => {
    const root = tempDir();
    const binPath = path.join(root, 'bin', 'ashlr');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: missing\n', 'utf8');

    expect(inspectDaemonSourceCheckout(binPath)).toMatchObject({ state: 'unverifiable', root });
    expect(() => assertDaemonServiceSourceClean(binPath)).toThrow(
      `Refusing to install daemon service from unverifiable Git checkout: ${root}`,
    );
  });
});
