import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _setWindowsFileAuthorityTestControlForTest,
  hardenWindowsFileAuthority,
  validateWindowsFileAuthority,
  WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
  type WindowsFileAuthorityInvocation,
  type WindowsFileAuthorityMode,
} from '../src/core/daemon/windows-file-authority.js';
import { installLaunchdPlistTransaction } from '../src/core/daemon/launchd-plist-transaction.js';
import { windowsPowerShellPath } from '../src/core/daemon/windows-task-scripts.js';

const WINDOWS_OPTIONS = {
  anchorPath: 'C:\\Users\\mason',
  platform: 'win32' as const,
  systemRoot: 'C:\\Windows',
};

interface AuthorityRequest {
  schemaVersion: number;
  operation: string;
  nonce: string;
  path: string;
  anchorPath: string;
  kind: string;
  mode: WindowsFileAuthorityMode;
}

function requestFrom(invocation: WindowsFileAuthorityInvocation): AuthorityRequest {
  return JSON.parse(invocation.input) as AuthorityRequest;
}

function response(
  invocation: WindowsFileAuthorityInvocation,
  ok: boolean,
  reason: string,
): string {
  const request = requestFrom(invocation);
  return JSON.stringify({
    schemaVersion: 1,
    operation: 'ashlr-windows-file-authority',
    nonce: request.nonce,
    ok,
    reason,
  });
}

function successfulRunner(expectedMode: WindowsFileAuthorityMode) {
  return (invocation: WindowsFileAuthorityInvocation) => {
    const request = requestFrom(invocation);
    expect(request.mode).toBe(expectedMode);
    const reason = expectedMode === 'validate' ? 'trusted-path' : 'hardened-path';
    return { status: 0, stdout: response(invocation, true, reason) };
  };
}

afterEach(() => {
  _setWindowsFileAuthorityTestControlForTest(
    WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
    undefined,
  );
  vi.restoreAllMocks();
});

describe('Windows service-file authority protocol', () => {
  it('resolves Windows PowerShell from canonical SystemRoot instead of hostile PATH', () => {
    const executable = windowsPowerShellPath({
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`D:\UntrustedWindows`,
      PATH: String.raw`C:\hostile-bin;C:\also-hostile`,
    });

    expect(executable).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(executable).not.toContain('hostile');
    expect(executable).not.toContain('UntrustedWindows');
  });

  it('uses a fixed executable and argv while carrying bounded paths in JSON stdin', () => {
    let observed: WindowsFileAuthorityInvocation | undefined;
    _setWindowsFileAuthorityTestControlForTest(
      WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
      {
        runner: successfulRunner('validate'),
        observeInvocation: (invocation) => {
          observed = invocation;
        },
      },
    );

    expect(validateWindowsFileAuthority(
      'C:\\Users\\mason\\.ashlr\\ashlr-daemon.cmd',
      'file',
      WINDOWS_OPTIONS,
    )).toEqual({ ok: true, reason: 'trusted-path' });

    expect(observed).toBeDefined();
    expect(observed!.executable).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(observed!.args.slice(0, -1)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ]);
    expect(observed!.args.join(' ')).not.toContain('ashlr-daemon.cmd');
    expect(observed!.maxBuffer).toBe(2 * 1024);
    expect(observed!.timeoutMs).toBe(8_000);
    expect(requestFrom(observed!)).toMatchObject({
      schemaVersion: 1,
      operation: 'ashlr-windows-file-authority',
      path: 'C:\\Users\\mason\\.ashlr\\ashlr-daemon.cmd',
      anchorPath: 'C:\\Users\\mason',
      kind: 'file',
      mode: 'validate',
    });
    expect(requestFrom(observed!).nonce).toMatch(/^[a-f0-9]{32}$/);
  });

  it('encodes current-SID, reparse, untrusted-write, and exact-DACL checks', () => {
    let observed: WindowsFileAuthorityInvocation | undefined;
    _setWindowsFileAuthorityTestControlForTest(
      WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
      {
        runner: successfulRunner('harden'),
        observeInvocation: (invocation) => {
          observed = invocation;
        },
      },
    );

    expect(hardenWindowsFileAuthority(
      'C:\\Users\\mason\\.ashlr',
      'directory',
      WINDOWS_OPTIONS,
    )).toEqual({ ok: true, reason: 'hardened-path' });

    const script = Buffer.from(observed!.args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain('WindowsIdentity]::GetCurrent().User');
    expect(script).toContain("SecurityIdentifier]::new('S-1-5-18')");
    expect(script).toContain("SecurityIdentifier]::new('S-1-5-32-544')");
    expect(script).toContain('FileAttributes]::ReparsePoint');
    expect(script).toContain('GetAccessRules(');
    expect(script).toContain('$binary = $security.GetSecurityDescriptorBinaryForm()');
    expect(script).not.toContain('GetSecurityDescriptorBinaryForm().Length');
    expect(script).toContain('SetAccessRuleProtection($true, $false)');
    expect(script).toContain('FileSystemRights]::FullControl');
    expect(script).toContain(
      "AssertSafeRules $itemAcl $trustedSids 'untrusted-item-write'",
    );
    expect(script).toContain(
      "AssertSafeRules $ancestorAcl $trustedSids 'untrusted-ancestor-write'",
    );
    expect(script).toContain(
      "$request.mode -eq 'validate' -and $itemOwner -ne $current.Value",
    );
    expect(script).toContain(
      "$request.mode -eq 'harden' -and",
    );
    expect(script).toContain(
      '@($current.Value, $administrators.Value) -notcontains $itemOwner',
    );
    expect(script).toContain(
      "$request.mode -eq 'harden' -and $itemOwner -ne $current.Value",
    );
    expect(script).not.toContain('Write-Host');
    expect(script).not.toContain('C:\\Users\\mason');
  });

  it.each([
    'untrusted-item-write',
    'untrusted-ancestor-write',
    'reparse-point',
    'reparse-ancestor',
    'wrong-owner',
    'null-dacl',
    'noncanonical-dacl',
    'adapter-error-read-item-acl',
  ])('returns only the bounded failure code %s', (reason) => {
    _setWindowsFileAuthorityTestControlForTest(
      WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
      {
        runner: (invocation) => ({
          status: 1,
          stdout: response(invocation, false, reason),
        }),
      },
    );

    expect(validateWindowsFileAuthority(
      'C:\\Users\\mason\\.ashlr\\service.cmd',
      'file',
      WINDOWS_OPTIONS,
    )).toEqual({ ok: false, reason });
  });

  it.each([
    {
      name: 'empty',
      result: () => ({ status: 0, stdout: '' }),
    },
    {
      name: 'invalid JSON',
      result: () => ({ status: 0, stdout: '{' }),
    },
    {
      name: 'leading whitespace',
      result: (invocation: WindowsFileAuthorityInvocation) => ({
        status: 0,
        stdout: ` ${response(invocation, true, 'trusted-path')}`,
      }),
    },
    {
      name: 'trailing newline',
      result: (invocation: WindowsFileAuthorityInvocation) => ({
        status: 0,
        stdout: `${response(invocation, true, 'trusted-path')}\n`,
      }),
    },
    {
      name: 'reordered keys',
      result: (invocation: WindowsFileAuthorityInvocation) => {
        const request = requestFrom(invocation);
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            nonce: request.nonce,
            operation: request.operation,
            reason: 'trusted-path',
            schemaVersion: 1,
          }),
        };
      },
    },
    {
      name: 'extra key',
      result: (invocation: WindowsFileAuthorityInvocation) => {
        const parsed = JSON.parse(
          response(invocation, true, 'trusted-path'),
        ) as Record<string, unknown>;
        return {
          status: 0,
          stdout: JSON.stringify({ ...parsed, detail: 'private ACL data' }),
        };
      },
    },
    {
      name: 'stale nonce',
      result: () => ({
        status: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          operation: 'ashlr-windows-file-authority',
          nonce: '0'.repeat(32),
          ok: true,
          reason: 'trusted-path',
        }),
      }),
    },
    {
      name: 'wrong operation',
      result: (invocation: WindowsFileAuthorityInvocation) => {
        const request = requestFrom(invocation);
        return {
          status: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            operation: 'other-operation',
            nonce: request.nonce,
            ok: true,
            reason: 'trusted-path',
          }),
        };
      },
    },
    {
      name: 'unknown success reason',
      result: (invocation: WindowsFileAuthorityInvocation) => ({
        status: 0,
        stdout: response(invocation, true, 'looks-safe'),
      }),
    },
    {
      name: 'failure on a zero exit',
      result: (invocation: WindowsFileAuthorityInvocation) => ({
        status: 0,
        stdout: response(invocation, false, 'wrong-owner'),
      }),
    },
    {
      name: 'success on a failure exit',
      result: (invocation: WindowsFileAuthorityInvocation) => ({
        status: 1,
        stdout: response(invocation, true, 'trusted-path'),
      }),
    },
    {
      name: 'unexpected exit status',
      result: (invocation: WindowsFileAuthorityInvocation) => ({
        status: 2,
        stdout: response(invocation, false, 'wrong-owner'),
      }),
    },
    {
      name: 'missing exit status',
      result: (invocation: WindowsFileAuthorityInvocation) => ({
        status: null,
        stdout: response(invocation, true, 'trusted-path'),
      }),
    },
    {
      name: 'oversized output',
      result: () => ({ status: 0, stdout: Buffer.alloc(2_049, 0x61) }),
    },
  ])('fails closed on $name output', ({ result }) => {
    _setWindowsFileAuthorityTestControlForTest(
      WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
      { runner: result },
    );

    expect(validateWindowsFileAuthority(
      'C:\\Users\\mason\\.ashlr\\service.cmd',
      'file',
      WINDOWS_OPTIONS,
    )).toEqual({ ok: false, reason: expect.stringMatching(
      /^(invalid-output|adapter-failed)$/,
    ) });
  });

  it('contains runner errors and never logs raw output, ACLs, paths, or identities', () => {
    const spies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];
    _setWindowsFileAuthorityTestControlForTest(
      WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
      {
        runner: () => ({
          status: null,
          stdout: '{"privateAcl":"secret"}',
          error: new Error('secret-domain\\private-user'),
        }),
      },
    );

    expect(validateWindowsFileAuthority(
      'C:\\Users\\mason\\.ashlr\\service.cmd',
      'file',
      WINDOWS_OPTIONS,
    )).toEqual({ ok: false, reason: 'adapter-failed' });
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('fails closed before invoking PowerShell for invalid or unscoped paths', () => {
    const runner = vi.fn(successfulRunner('validate'));
    _setWindowsFileAuthorityTestControlForTest(
      WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
      { runner },
    );

    const cases = [
      validateWindowsFileAuthority('relative\\service.cmd', 'file', WINDOWS_OPTIONS),
      validateWindowsFileAuthority('\\\\server\\share\\service.cmd', 'file', WINDOWS_OPTIONS),
      validateWindowsFileAuthority(
        'C:\\Users\\mason\\.ashlr\\service.cmd:stream',
        'file',
        WINDOWS_OPTIONS,
      ),
      validateWindowsFileAuthority(
        'C:\\Users\\other\\service.cmd',
        'file',
        WINDOWS_OPTIONS,
      ),
      validateWindowsFileAuthority(
        'C:\\Users\\mason\\.ashlr\\service.cmd',
        'file',
        { ...WINDOWS_OPTIONS, systemRoot: 'relative' },
      ),
      validateWindowsFileAuthority(
        'C:\\Users\\mason\\.ashlr\\service.cmd',
        'file',
        { ...WINDOWS_OPTIONS, platform: 'linux' },
      ),
    ];

    expect(cases).toEqual([
      { ok: false, reason: 'invalid-path' },
      { ok: false, reason: 'invalid-path' },
      { ok: false, reason: 'invalid-path' },
      { ok: false, reason: 'invalid-anchor' },
      { ok: false, reason: 'powershell-unavailable' },
      { ok: false, reason: 'unsupported-platform' },
    ]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('accepts an exact anchor target and clamps caller timeouts', () => {
    let observed: WindowsFileAuthorityInvocation | undefined;
    _setWindowsFileAuthorityTestControlForTest(
      WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
      {
        runner: successfulRunner('validate'),
        observeInvocation: (invocation) => {
          observed = invocation;
        },
      },
    );

    expect(validateWindowsFileAuthority(
      'C:\\Users\\mason',
      'directory',
      { ...WINDOWS_OPTIONS, timeoutMs: 50_000 },
    )).toEqual({ ok: true, reason: 'trusted-path' });
    expect(observed!.timeoutMs).toBe(15_000);
  });

  it('protects the test-control injection boundary', () => {
    expect(() => _setWindowsFileAuthorityTestControlForTest(
      Symbol('wrong'),
      { runner: successfulRunner('validate') },
    )).toThrow('Invalid Windows file authority test control sentinel');
  });
});

describe.runIf(process.platform === 'win32')(
  'Windows service-file authority integration',
  () => {
    it('rejects BUILTIN Users Modify without changing the file', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-wfa-'));
      const serviceFile = path.join(root, 'ashlr-daemon.cmd');
      try {
        expect(hardenWindowsFileAuthority(root, 'directory', {
          anchorPath: root,
        })).toEqual({ ok: true, reason: 'hardened-path' });
        fs.writeFileSync(serviceFile, '@echo off\r\nexit /b 0\r\n', {
          encoding: 'utf8',
          flag: 'wx',
        });
        expect(hardenWindowsFileAuthority(serviceFile, 'file', {
          anchorPath: root,
        })).toEqual({ ok: true, reason: 'hardened-path' });
        expect(validateWindowsFileAuthority(serviceFile, 'file', {
          anchorPath: root,
        })).toEqual({ ok: true, reason: 'trusted-path' });

        execFileSync(
          'icacls.exe',
          [serviceFile, '/grant', '*S-1-5-32-545:(M)', '/Q'],
          { stdio: 'ignore', windowsHide: true },
        );
        const before = fs.readFileSync(serviceFile);

        expect(validateWindowsFileAuthority(serviceFile, 'file', {
          anchorPath: root,
        })).toEqual({ ok: false, reason: 'untrusted-item-write' });
        expect(fs.readFileSync(serviceFile)).toEqual(before);
        expect(validateWindowsFileAuthority(serviceFile, 'file', {
          anchorPath: root,
        })).toEqual({ ok: false, reason: 'untrusted-item-write' });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('blocks a service transaction before unload when the launcher ACL is unsafe', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-wfa-transaction-'));
      const serviceFile = path.join(root, 'services', 'ashlr-daemon.cmd');
      const lockDir = path.join(root, 'locks');
      try {
        expect(hardenWindowsFileAuthority(root, 'directory', {
          anchorPath: root,
        })).toEqual({ ok: true, reason: 'hardened-path' });
        installLaunchdPlistTransaction({
          plistPath: serviceFile,
          trustedRoot: root,
          content: '@echo off\r\nexit /b 0\r\n',
          lockDir,
          unload: () => ({ ok: true, stderr: '' }),
          load: () => ({ ok: true, stderr: '' }),
        });

        execFileSync(
          'icacls.exe',
          [serviceFile, '/grant', '*S-1-5-32-545:(M)', '/Q'],
          { stdio: 'ignore', windowsHide: true },
        );
        const unload = vi.fn(() => ({ ok: true, stderr: '' }));

        expect(() => installLaunchdPlistTransaction({
          plistPath: serviceFile,
          trustedRoot: root,
          content: '@echo off\r\nexit /b 1\r\n',
          lockDir,
          unload,
          load: () => ({ ok: true, stderr: '' }),
        })).toThrow('unsafe Windows file authority: untrusted-item-write');
        expect(unload).not.toHaveBeenCalled();
        expect(fs.readFileSync(serviceFile, 'utf8')).toBe('@echo off\r\nexit /b 0\r\n');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
