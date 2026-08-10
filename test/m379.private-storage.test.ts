import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
  assurePrivateStoragePath,
  assurePrivateStoragePaths,
  type PrivateStorageInvocation,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';

const homes: string[] = [];

afterEach(() => {
  try {
    for (const home of homes.splice(0)) {
      if (process.platform === 'darwin') {
        spawnSync('/bin/chmod', ['-RN', home], {
          shell: false, timeout: 5_000, encoding: 'utf8',
        });
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  } finally {
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function successfulRunner(
  calls: PrivateStorageInvocation[],
  reason = 'exact-private-dacl',
): PrivateStorageRunner {
  return (invocation) => {
    calls.push(invocation);
    const request = JSON.parse(invocation.input) as { nonce: string; operation: string };
    return {
      status: 0,
      stdout: JSON.stringify({
        nonce: request.nonce,
        operation: request.operation,
        ok: true,
        reason,
      }),
    };
  };
}

describe('M379 private-storage assurance', () => {
  it('shares the sentinel-guarded test control across module evaluation boundaries', async () => {
    const runnerCalls: PrivateStorageInvocation[] = [];
    const observed: PrivateStorageInvocation[] = [];
    expect(Symbol.keyFor(PRIVATE_STORAGE_TEST_CONTROL))
      .toBe('ashlr.private-storage.test-control.v1');
    expect(() => _setPrivateStorageTestControlForTest(Symbol('wrong'), {
      runner: successfulRunner(runnerCalls),
    })).toThrow(/sentinel/i);

    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      runner: successfulRunner(runnerCalls),
      observeInvocation: (invocation) => {
        observed.push(invocation);
        invocation.args[0] = 'observer-mutation';
      },
    });
    vi.resetModules();
    const duplicate = await import('../src/core/util/private-storage.js');
    expect(duplicate.PRIVATE_STORAGE_TEST_CONTROL).toBe(PRIVATE_STORAGE_TEST_CONTROL);
    expect(duplicate.assurePrivateStoragePath('C:\\tmp\\private', 'file', 'secure-created', {
      platform: 'win32', systemRoot: 'C:\\Windows', anchorPath: 'C:\\tmp',
    })).toEqual({ ok: true, reason: 'exact-private-dacl' });
    expect(observed).toHaveLength(1);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.args[0]).toBe('-NoLogo');
  });

  it('keeps authenticated output validation active for the canonical test runner', () => {
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      runner: (invocation) => {
        const request = JSON.parse(invocation.input) as { operation: string };
        return { status: 0, stdout: JSON.stringify({
          nonce: '0'.repeat(32),
          operation: request.operation,
          ok: true,
          reason: 'exact-private-dacl',
        }) };
      },
    });
    expect(assurePrivateStoragePath('C:\\tmp\\private', 'file', 'secure-created', {
      platform: 'win32', systemRoot: 'C:\\Windows', anchorPath: 'C:\\tmp',
    })).toEqual({ ok: false, reason: 'invalid-output' });
  });

  it('prefers an explicit per-call runner without invoking the global test runner', () => {
    const globalCalls: PrivateStorageInvocation[] = [];
    const explicitCalls: PrivateStorageInvocation[] = [];
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      runner: successfulRunner(globalCalls),
    });

    expect(assurePrivateStoragePath('C:\\tmp\\private', 'file', 'secure-created', {
      platform: 'win32', systemRoot: 'C:\\Windows', anchorPath: 'C:\\tmp',
      runner: successfulRunner(explicitCalls),
    })).toEqual({ ok: true, reason: 'exact-private-dacl' });
    expect(explicitCalls).toHaveLength(1);
    expect(globalCalls).toHaveLength(0);
  });

  it('fails closed before invoking the configured runner when the global observer throws', () => {
    const runnerCalls: PrivateStorageInvocation[] = [];
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      runner: successfulRunner(runnerCalls),
      observeInvocation: () => { throw new Error('observer failed'); },
    });

    expect(assurePrivateStoragePath('C:\\tmp\\private', 'file', 'secure-created', {
      platform: 'win32', systemRoot: 'C:\\Windows', anchorPath: 'C:\\tmp',
    })).toEqual({ ok: false, reason: 'adapter-failed' });
    expect(runnerCalls).toHaveLength(0);
  });

  it('rejects enabling the canonical test runner outside Vitest context', () => {
    vi.stubEnv('VITEST', 'false');
    expect(() => _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      runner: successfulRunner([]),
    })).toThrow(/restricted to Vitest/);
  });

  it('uses a fixed executable/encoded argv and carries hostile paths only in JSON stdin', () => {
    const calls: PrivateStorageInvocation[] = [];
    const path = 'C:\\tmp\\path with spaces\\$env:USER;Remove-Item *\\[x]';
    expect(assurePrivateStoragePath(path, 'file', 'secure-created', {
      platform: 'win32', systemRoot: 'C:\\Windows', anchorPath: 'C:\\tmp',
      runner: successfulRunner(calls),
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
      schemaVersion: 1, operation: 'assure-private-path', anchorPath: 'C:\\tmp',
      path, kind: 'file', mode: 'secure-created',
    });
    expect(calls[0]!.timeoutMs).toBe(5_000);
    expect(calls[0]!.maxBuffer).toBe(4 * 1024);
  });

  it('fails closed on process errors, status failures, malformed output, and nonce substitution', () => {
    const base = {
      platform: 'win32' as const, systemRoot: 'C:\\Windows', anchorPath: 'C:\\tmp',
    };
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

  it('backs off for authenticated transient ACL errors and returns the final stage silently', () => {
    const waits: Array<{ delayMs: number; reason: string }> = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let calls = 0;
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      waitForRetry: (delayMs, reason) => waits.push({ delayMs, reason }),
    });
    const result = assurePrivateStoragePath(
      'C:\\tmp\\private',
      'directory',
      'inspect-existing',
      {
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        anchorPath: 'C:\\tmp',
        runner: (invocation) => {
          calls += 1;
          const request = JSON.parse(invocation.input) as { nonce: string; operation: string };
          const reason = calls === 1
            ? 'adapter-error-load-item'
            : 'adapter-error-readback-acl';
          return { status: 1, stdout: JSON.stringify({
            nonce: request.nonce,
            operation: request.operation,
            ok: false,
            reason,
          }) };
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: 'adapter-error-readback-acl' });
    expect(calls).toBe(2);
    expect(waits).toEqual([
      { delayMs: 50, reason: 'adapter-error-load-item' },
    ]);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('does not retry or emit transient diagnostics for deterministic ACL denial', () => {
    const waits = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let calls = 0;
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      waitForRetry: waits,
    });
    const result = assurePrivateStoragePath(
      'C:\\tmp\\private',
      'directory',
      'inspect-existing',
      {
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        anchorPath: 'C:\\tmp',
        runner: (invocation) => {
          calls += 1;
          const request = JSON.parse(invocation.input) as { nonce: string; operation: string };
          return { status: 1, stdout: JSON.stringify({
            nonce: request.nonce,
            operation: request.operation,
            ok: false,
            reason: 'untrusted-ancestor-owner',
          }) };
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: 'untrusted-ancestor-owner' });
    expect(calls).toBe(1);
    expect(waits).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('supports non-mutating owner and ancestor assurance for observational reads', () => {
    const calls: PrivateStorageInvocation[] = [];
    expect(assurePrivateStoragePath('C:\\tmp\\record.json', 'file', 'inspect-owned', {
      platform: 'win32', systemRoot: 'C:\\Windows', anchorPath: 'C:\\tmp',
      runner: successfulRunner(calls, 'owned-safe-path'),
    })).toEqual({ ok: true, reason: 'owned-safe-path' });
    expect(JSON.parse(calls[0]!.input)).toMatchObject({ mode: 'inspect-owned' });
  });

  it('checks a bounded file batch in one authenticated adapter invocation', () => {
    const calls: PrivateStorageInvocation[] = [];
    expect(assurePrivateStoragePaths([
      'C:\\tmp\\one.json',
      'C:\\tmp\\two.json',
    ], {
      platform: 'win32', systemRoot: 'C:\\Windows', anchorPath: 'C:\\tmp',
      runner: successfulRunner(calls, 'owned-safe-paths'),
    })).toEqual({ ok: true, reason: 'owned-safe-paths' });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.input)).toMatchObject({
      operation: 'assure-private-paths',
      paths: ['C:\\tmp\\one.json', 'C:\\tmp\\two.json'],
    });
    expect(calls[0]!.timeoutMs).toBe(15_000);
  });

  it('rejects invalid paths and bypasses PowerShell on non-Darwin POSIX', () => {
    const runner = vi.fn<PrivateStorageRunner>();
    for (const invalid of ['relative', '\\root-relative', '\\\\server\\share\\key', '\\\\.\\pipe\\key']) {
      expect(assurePrivateStoragePath(invalid, 'file', 'inspect-existing', {
        platform: 'win32', systemRoot: 'C:\\Windows', anchorPath: 'C:\\tmp', runner,
      })).toEqual({ ok: false, reason: 'invalid-path' });
    }
    expect(assurePrivateStoragePath('/tmp/private', 'file', 'inspect-existing', {
      platform: 'linux',
      runner,
    })).toEqual({ ok: true, reason: 'posix-checked-by-caller' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('uses bounded argv-only Darwin ACL inspection and accepts the standard everyone deny delete ACE', () => {
    const calls: PrivateStorageInvocation[] = [];
    const result = assurePrivateStoragePath('/Users/alice/.ashlr/daemon.json', 'file', 'inspect-owned', {
      platform: 'darwin',
      anchorPath: '/Users/alice',
      runner: (invocation) => {
        calls.push(invocation);
        return {
          status: 0,
          stdout: [
            'drwxr-xr-x+ 1 alice staff 0 Aug 10 00:00 /Users/alice',
            ' 0: group:everyone deny delete',
            'drwx------ 1 alice staff 0 Aug 10 00:00 /Users/alice/.ashlr',
            '-rw------- 1 alice staff 1 Aug 10 00:00 /Users/alice/.ashlr/daemon.json',
            '',
          ].join('\n'),
        };
      },
    });

    expect(result).toEqual({ ok: true, reason: 'darwin-acl-safe' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: '/bin/ls',
      args: [
        '-lde',
        '/Users/alice',
        '/Users/alice/.ashlr',
        '/Users/alice/.ashlr/daemon.json',
      ],
      input: '',
      timeoutMs: 5_000,
      maxBuffer: 64 * 1024,
      env: { LC_ALL: 'C', LANG: 'C' },
    });
  });

  it('rejects dangerous untrusted Darwin allow and inheritance grants but permits owner grants', () => {
    const metadata = [
      'drwxr-xr-x+ 1 owner staff 0 Aug 10 00:00 /Users/owner',
      'drwx------+ 1 owner staff 0 Aug 10 00:00 /Users/owner/.ashlr',
      '-rw------- 1 owner staff 1 Aug 10 00:00 /Users/owner/.ashlr/daemon.json',
    ];
    const inspect = (aclLine: string) => assurePrivateStoragePath(
      '/Users/owner/.ashlr/daemon.json',
      'file',
      'inspect-owned',
      {
        platform: 'darwin',
        anchorPath: '/Users/owner',
        runner: () => ({
          status: 0,
          stdout: [metadata[0], aclLine, ...metadata.slice(1), ''].join('\n'),
        }),
      },
    );

    expect(inspect(
      ' 0: group:everyone allow list,add_file,search,add_subdirectory,delete_child,file_inherit,directory_inherit',
    )).toEqual({ ok: false, reason: 'darwin-untrusted-allow' });
    expect(inspect(' 0: group:everyone inherited allow read,write,execute,append'))
      .toEqual({ ok: false, reason: 'darwin-untrusted-allow' });
    expect(inspect(` 0: user:${userInfo().username} allow read,write,append`))
      .toEqual({ ok: true, reason: 'darwin-acl-safe' });
  });

  it('fails Darwin ACL inspection closed on malformed output, wrong kinds, and process failure', () => {
    const options = {
      platform: 'darwin' as const,
      anchorPath: '/Users/alice',
    };
    expect(assurePrivateStoragePath('/Users/alice/key', 'file', 'inspect-owned', {
      ...options,
      runner: () => ({ status: 0, stdout: 'not-ls-output\n' }),
    })).toEqual({ ok: false, reason: 'invalid-output' });
    expect(assurePrivateStoragePath('/Users/alice/key', 'file', 'inspect-owned', {
      ...options,
      runner: () => ({
        status: 0,
        stdout: [
          'drwxr-xr-x 1 alice staff 0 Aug 10 00:00 /Users/alice',
          'drwx------ 1 alice staff 0 Aug 10 00:00 /Users/alice/key',
          '',
        ].join('\n'),
      }),
    })).toEqual({ ok: false, reason: 'darwin-wrong-kind' });
    expect(assurePrivateStoragePath('/Users/alice/key', 'file', 'inspect-owned', {
      ...options,
      runner: () => ({ status: null, error: new Error('timeout') }),
    })).toEqual({ ok: false, reason: 'adapter-failed' });
  });

  it.runIf(process.platform === 'darwin')('accepts a native standard home ACL and rejects an inheritable Everyone grant', () => {
    const home = mkdtempSync(join(tmpdir(), 'ashlr-m379-darwin-'));
    homes.push(home);
    chmodSync(home, 0o755);
    const dir = join(home, '.ashlr');
    const file = join(dir, 'daemon.json');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(file, '{}\n', { mode: 0o600 });

    const standardAcl = spawnSync('/bin/chmod', ['+a', 'everyone deny delete', home], {
      shell: false, timeout: 5_000, encoding: 'utf8',
    });
    expect(standardAcl.status, standardAcl.stderr).toBe(0);
    expect(assurePrivateStoragePath(file, 'file', 'inspect-owned', { anchorPath: home }))
      .toEqual({ ok: true, reason: 'darwin-acl-safe' });

    const removeStandardAcl = spawnSync('/bin/chmod', ['-N', home], {
      shell: false, timeout: 5_000, encoding: 'utf8',
    });
    expect(removeStandardAcl.status, removeStandardAcl.stderr).toBe(0);
    const hostileAcl = spawnSync('/bin/chmod', [
      '+a',
      'everyone allow list,add_file,search,add_subdirectory,delete_child,file_inherit,directory_inherit',
      home,
    ], { shell: false, timeout: 5_000, encoding: 'utf8' });
    expect(hostileAcl.status, hostileAcl.stderr).toBe(0);
    expect(assurePrivateStoragePath(file, 'file', 'inspect-owned', { anchorPath: home }))
      .toEqual({ ok: false, reason: 'darwin-untrusted-allow' });
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
    const directoryAssurance = assurePrivateStoragePath(dir, 'directory', 'secure-created', {
      anchorPath: home,
    });
    expect(directoryAssurance, directoryAssurance.reason).toMatchObject({ ok: true });
    const fd = openSync(file, 'wx', 0o600);
    closeSync(fd);
    expect(assurePrivateStoragePath(file, 'file', 'secure-created', { anchorPath: home }))
      .toMatchObject({ ok: true });
    writeFileSync(file, Buffer.alloc(32, 7));
    expect(assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: home }))
      .toMatchObject({ ok: true });

    const ancestorMutation = spawnSync('icacls.exe', [home, '/grant', '*S-1-1-0:(WDAC)'], {
      windowsHide: true, shell: false, timeout: 5_000, encoding: 'utf8',
    });
    expect(ancestorMutation.status, ancestorMutation.stderr).toBe(0);
    expect(assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: home }).ok)
      .toBe(false);
    const restoreAncestor = spawnSync('icacls.exe', [home, '/remove:g', '*S-1-1-0'], {
      windowsHide: true, shell: false, timeout: 5_000, encoding: 'utf8',
    });
    expect(restoreAncestor.status, restoreAncestor.stderr).toBe(0);
    expect(assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: home }))
      .toMatchObject({ ok: true });

    const mutation = spawnSync('icacls.exe', [file, '/grant', '*S-1-1-0:R'], {
      windowsHide: true, shell: false, timeout: 5_000, encoding: 'utf8',
    });
    expect(mutation.status, mutation.stderr).toBe(0);
    expect(assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: home }).ok)
      .toBe(false);
  }, 45_000);
});
