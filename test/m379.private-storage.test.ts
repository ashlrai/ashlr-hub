import { mkdtempSync, openSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assurePrivateStoragePath,
  type PrivateStorageInvocation,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

function successfulRunner(calls: PrivateStorageInvocation[]): PrivateStorageRunner {
  return (invocation) => {
    calls.push(invocation);
    const request = JSON.parse(invocation.input) as { nonce: string; operation: string };
    return {
      status: 0,
      stdout: JSON.stringify({
        nonce: request.nonce,
        operation: request.operation,
        ok: true,
        reason: 'exact-private-dacl',
      }),
    };
  };
}

describe('M379 Windows private-storage assurance', () => {
  it('uses a fixed executable/encoded argv and carries hostile paths only in JSON stdin', () => {
    const calls: PrivateStorageInvocation[] = [];
    const path = 'C:\\tmp\\path with spaces\\$env:USER;Remove-Item *\\[x]';
    expect(assurePrivateStoragePath(path, 'file', 'secure-created', {
      platform: 'win32', systemRoot: 'C:\\Windows', runner: successfulRunner(calls),
    })).toEqual({ ok: true, reason: 'exact-private-dacl' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.executable).toBe(win32.join(
      'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    ));
    expect(calls[0]!.args.slice(0, -1)).toEqual([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    ]);
    expect(calls[0]!.args.at(-1)).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(calls[0]!.args.join(' ')).not.toContain(path);
    expect(JSON.parse(calls[0]!.input)).toMatchObject({
      schemaVersion: 1, operation: 'assure-private-path', path, kind: 'file', mode: 'secure-created',
    });
    expect(calls[0]!.timeoutMs).toBe(5_000);
    expect(calls[0]!.maxBuffer).toBe(4 * 1024);
  });

  it('fails closed on process errors, status failures, malformed output, and nonce substitution', () => {
    const base = { platform: 'win32' as const, systemRoot: 'C:\\Windows' };
    const runners: PrivateStorageRunner[] = [
      () => ({ status: null, error: new Error('timeout') }),
      () => ({ status: 1, stdout: '' }),
      () => ({ status: 0, stdout: '{' }),
      (invocation) => {
        const request = JSON.parse(invocation.input) as { operation: string };
        return { status: 0, stdout: JSON.stringify({
          nonce: '0'.repeat(32), operation: request.operation, ok: true, reason: 'exact-private-dacl',
        }) };
      },
    ];
    for (const runner of runners) {
      expect(assurePrivateStoragePath('C:\\tmp\\private', 'directory', 'inspect-existing', {
        ...base, runner,
      }).ok).toBe(false);
    }
    const authenticatedFailure: PrivateStorageRunner = (invocation) => {
      const request = JSON.parse(invocation.input) as { nonce: string; operation: string };
      return { status: 1, stdout: JSON.stringify({
        nonce: request.nonce, operation: request.operation, ok: false, reason: 'untrusted-ancestor-owner',
      }) };
    };
    expect(assurePrivateStoragePath('C:\\tmp\\private', 'directory', 'inspect-existing', {
      ...base, runner: authenticatedFailure,
    })).toEqual({ ok: false, reason: 'untrusted-ancestor-owner' });
  });

  it('rejects invalid paths and bypasses PowerShell on POSIX', () => {
    const runner = vi.fn<PrivateStorageRunner>();
    for (const invalid of ['relative', '\\root-relative', '\\\\server\\share\\key', '\\\\.\\pipe\\key']) {
      expect(assurePrivateStoragePath(invalid, 'file', 'inspect-existing', {
        platform: 'win32', systemRoot: 'C:\\Windows', runner,
      })).toEqual({ ok: false, reason: 'invalid-path' });
    }
    expect(assurePrivateStoragePath('/tmp/private', 'file', 'inspect-existing', {
      platform: process.platform === 'win32' ? 'linux' : process.platform,
      runner,
    })).toEqual({ ok: true, reason: 'posix-checked-by-caller' });
    expect(runner).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('applies and verifies an exact DACL and rejects an added Everyone ACE', () => {
    const home = mkdtempSync(join(tmpdir(), 'ashlr-m379-'));
    homes.push(home);
    const dir = join(home, 'private');
    const file = join(dir, 'key');
    // mkdir through PowerShell would test a different boundary; Node creates the
    // empty objects, then the adapter must secure them before secret bytes exist.
    const mkdir = spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(dir)})`]);
    expect(mkdir.status).toBe(0);
    const directoryAssurance = assurePrivateStoragePath(dir, 'directory', 'secure-created');
    expect(directoryAssurance, directoryAssurance.reason).toMatchObject({ ok: true });
    const fd = openSync(file, 'wx', 0o600);
    closeSync(fd);
    expect(assurePrivateStoragePath(file, 'file', 'secure-created')).toMatchObject({ ok: true });
    writeFileSync(file, Buffer.alloc(32, 7));
    expect(assurePrivateStoragePath(file, 'file', 'inspect-existing')).toMatchObject({ ok: true });

    const ancestorMutation = spawnSync('icacls.exe', [home, '/grant', '*S-1-1-0:(WDAC)'], {
      windowsHide: true, shell: false, timeout: 5_000, encoding: 'utf8',
    });
    expect(ancestorMutation.status, ancestorMutation.stderr).toBe(0);
    expect(assurePrivateStoragePath(file, 'file', 'inspect-existing').ok).toBe(false);
    const restoreAncestor = spawnSync('icacls.exe', [home, '/remove:g', '*S-1-1-0'], {
      windowsHide: true, shell: false, timeout: 5_000, encoding: 'utf8',
    });
    expect(restoreAncestor.status, restoreAncestor.stderr).toBe(0);
    expect(assurePrivateStoragePath(file, 'file', 'inspect-existing')).toMatchObject({ ok: true });

    const mutation = spawnSync('icacls.exe', [file, '/grant', '*S-1-1-0:R'], {
      windowsHide: true, shell: false, timeout: 5_000, encoding: 'utf8',
    });
    expect(mutation.status, mutation.stderr).toBe(0);
    expect(assurePrivateStoragePath(file, 'file', 'inspect-existing').ok).toBe(false);
  }, 45_000);
});
