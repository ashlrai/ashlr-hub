import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';

const SCHEMA_VERSION = 1;
const OPERATION = 'ashlr-windows-file-authority';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 2 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_PATH_LENGTH = 4_096;

const WINDOWS_FILE_AUTHORITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = $null
$stage = 'read-input'

function Finish([bool]$ok, [string]$reason) {
  $nonce = if ($null -ne $request -and
    $null -ne $request.PSObject.Properties['nonce'] -and
    $request.nonce -is [string]) { $request.nonce } else { 'invalid' }
  $response = [ordered]@{
    schemaVersion = 1
    operation = 'ashlr-windows-file-authority'
    nonce = $nonce
    ok = $ok
    reason = $reason
  }
  [Console]::Out.Write(($response | ConvertTo-Json -Compress))
  exit $(if ($ok) { 0 } else { 1 })
}

function HasWriteAuthority(
  [System.Security.AccessControl.FileSystemAccessRule]$rule
) {
  $writeMask = [int64]2 -bor [int64]4 -bor [int64]16 -bor [int64]64 -bor
    [int64]256 -bor [int64]65536 -bor [int64]262144 -bor [int64]524288 -bor
    [int64]268435456 -bor [int64]1073741824
  return (([int64]$rule.FileSystemRights -band $writeMask) -ne 0)
}

function RawDaclIsPresent(
  [System.Security.AccessControl.FileSystemSecurity]$security
) {
  $binary = $security.GetSecurityDescriptorBinaryForm()
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($binary, 0)
  return $null -ne $raw.DiscretionaryAcl
}

function AssertSafeRules(
  [System.Security.AccessControl.FileSystemSecurity]$security,
  [string[]]$trustedSids,
  [string]$failureReason
) {
  if (-not (RawDaclIsPresent $security)) { Finish $false 'null-dacl' }
  if (-not $security.AreAccessRulesCanonical) { Finish $false 'noncanonical-dacl' }
  $rules = @($security.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ))
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq
        [System.Security.AccessControl.AccessControlType]::Allow -and
      (HasWriteAuthority $rule) -and
      $trustedSids -notcontains $rule.IdentityReference.Value) {
      Finish $false $failureReason
    }
  }
}

try {
  $rawInput = [Console]::In.ReadToEnd()
  if ([System.Text.Encoding]::UTF8.GetByteCount($rawInput) -gt 16384) {
    Finish $false 'invalid-input'
  }
  $request = $rawInput | ConvertFrom-Json
  $keys = @($request.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ',') -ne
    'anchorPath,kind,mode,nonce,operation,path,schemaVersion') {
    Finish $false 'invalid-input-shape'
  }
  if ($request.schemaVersion -ne 1 -or
    $request.operation -ne 'ashlr-windows-file-authority') {
    Finish $false 'invalid-input'
  }
  if ($request.kind -ne 'file' -and $request.kind -ne 'directory') {
    Finish $false 'invalid-kind'
  }
  if ($request.mode -ne 'validate' -and $request.mode -ne 'harden') {
    Finish $false 'invalid-mode'
  }

  $stage = 'normalize-paths'
  $targetFull = [System.IO.Path]::GetFullPath([string]$request.path)
  $anchorFull = [System.IO.Path]::GetFullPath([string]$request.anchorPath)
  $pathComparison = [System.StringComparison]::OrdinalIgnoreCase
  $anchorPrefix = $anchorFull.TrimEnd('\') + '\'
  if (-not $targetFull.Equals($anchorFull, $pathComparison) -and
    -not $targetFull.StartsWith($anchorPrefix, $pathComparison)) {
    Finish $false 'anchor-not-reached'
  }

  $stage = 'load-anchor'
  $anchor = Get-Item -LiteralPath $anchorFull -Force
  if (-not $anchor.PSIsContainer -or
    ($anchor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
    -not $anchor.FullName.Equals($anchorFull, $pathComparison)) {
    Finish $false 'invalid-anchor'
  }

  $stage = 'load-item'
  $item = Get-Item -LiteralPath $targetFull -Force
  if (-not $item.FullName.Equals($targetFull, $pathComparison)) {
    Finish $false 'path-mismatch'
  }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Finish $false 'reparse-point'
  }
  if ($request.kind -eq 'file' -and $item.PSIsContainer) {
    Finish $false 'wrong-kind'
  }
  if ($request.kind -eq 'directory' -and -not $item.PSIsContainer) {
    Finish $false 'wrong-kind'
  }

  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $administrators =
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $trustedSids = @(
    $current.Value,
    $system.Value,
    $administrators.Value
  ) | Select-Object -Unique

  if (-not $targetFull.Equals($anchorFull, $pathComparison)) {
    $stage = 'inspect-ancestors'
    $cursor = if ($request.kind -eq 'file') { $item.Directory } else { $item.Parent }
    $reachedAnchor = $false
    while ($null -ne $cursor) {
      if (($cursor.Attributes -band
          [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Finish $false 'reparse-ancestor'
      }
      $ancestorAcl = $cursor.GetAccessControl()
      $ancestorOwner = $ancestorAcl.GetOwner(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
      if ($trustedSids -notcontains $ancestorOwner) {
        Finish $false 'untrusted-ancestor-owner'
      }
      AssertSafeRules $ancestorAcl $trustedSids 'untrusted-ancestor-write'
      if ($cursor.FullName.Equals($anchorFull, $pathComparison)) {
        $reachedAnchor = $true
        break
      }
      $cursor = $cursor.Parent
    }
    if (-not $reachedAnchor) { Finish $false 'anchor-not-reached' }
  }

  $stage = 'read-item-acl'
  $itemAcl = $item.GetAccessControl()
  $itemOwner = $itemAcl.GetOwner(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
  if ($request.mode -eq 'validate' -and $itemOwner -ne $current.Value) {
    Finish $false 'wrong-owner'
  }
  if ($request.mode -eq 'harden' -and
    @($current.Value, $administrators.Value) -notcontains $itemOwner) {
    Finish $false 'wrong-owner'
  }
  if ($request.mode -eq 'harden' -and $itemOwner -ne $current.Value) {
    AssertSafeRules $itemAcl $trustedSids 'untrusted-item-write'
  }

  if ($request.mode -eq 'validate') {
    AssertSafeRules $itemAcl $trustedSids 'untrusted-item-write'
    Finish $true 'trusted-path'
  }

  $stage = 'build-acl'
  if ($request.kind -eq 'file') {
    $security = [System.Security.AccessControl.FileSecurity]::new()
    $inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
  } else {
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritanceFlags =
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  $security.SetOwner($current)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sidValue in $trustedSids) {
    $sid = [System.Security.Principal.SecurityIdentifier]::new($sidValue)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritanceFlags,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }

  $stage = 'apply-acl'
  $item.SetAccessControl($security)

  $stage = 'reload-item'
  $verified = Get-Item -LiteralPath $targetFull -Force
  if (-not $verified.FullName.Equals($targetFull, $pathComparison)) {
    Finish $false 'path-mismatch'
  }
  if (($verified.Attributes -band
      [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Finish $false 'reparse-point'
  }
  if ($request.kind -eq 'file' -and $verified.PSIsContainer) {
    Finish $false 'wrong-kind'
  }
  if ($request.kind -eq 'directory' -and -not $verified.PSIsContainer) {
    Finish $false 'wrong-kind'
  }

  $stage = 'verify-acl'
  $verifiedAcl = $verified.GetAccessControl()
  if ($verifiedAcl.GetOwner(
      [System.Security.Principal.SecurityIdentifier]
    ).Value -ne $current.Value) {
    Finish $false 'wrong-owner'
  }
  if (-not (RawDaclIsPresent $verifiedAcl)) { Finish $false 'null-dacl' }
  if (-not $verifiedAcl.AreAccessRulesCanonical) {
    Finish $false 'noncanonical-dacl'
  }
  if (-not $verifiedAcl.AreAccessRulesProtected) {
    Finish $false 'dacl-not-protected'
  }
  $rules = @($verifiedAcl.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ))
  if ($rules.Count -ne $trustedSids.Count) {
    Finish $false 'unexpected-ace-count'
  }
  $expectedFlags = if ($request.kind -eq 'file') { 0 } else { 3 }
  foreach ($sidValue in $trustedSids) {
    $matches = @($rules | Where-Object {
      $_.IdentityReference.Value -eq $sidValue
    })
    if ($matches.Count -ne 1) {
      Finish $false 'missing-or-duplicate-principal'
    }
    $verifiedRule = $matches[0]
    if ($verifiedRule.IsInherited) { Finish $false 'inherited-ace' }
    if ($verifiedRule.AccessControlType -ne
      [System.Security.AccessControl.AccessControlType]::Allow) {
      Finish $false 'wrong-access-type'
    }
    if ([int]$verifiedRule.FileSystemRights -ne
      [int][System.Security.AccessControl.FileSystemRights]::FullControl) {
      Finish $false 'wrong-rights'
    }
    if ([int]$verifiedRule.InheritanceFlags -ne $expectedFlags -or
      [int]$verifiedRule.PropagationFlags -ne 0) {
      Finish $false 'wrong-flags'
    }
  }
  Finish $true 'hardened-path'
} catch {
  Finish $false ('adapter-error-' + $stage)
}
`;

const ENCODED_WINDOWS_FILE_AUTHORITY_SCRIPT = Buffer.from(
  WINDOWS_FILE_AUTHORITY_SCRIPT,
  'utf16le',
).toString('base64');

export type WindowsFileAuthorityKind = 'file' | 'directory';
export type WindowsFileAuthorityMode = 'validate' | 'harden';

export interface WindowsFileAuthorityResult {
  ok: boolean;
  reason: string;
}

export interface WindowsFileAuthorityInvocation {
  executable: string;
  args: string[];
  input: string;
  timeoutMs: number;
  maxBuffer: number;
}

export type WindowsFileAuthorityRunner = (
  invocation: WindowsFileAuthorityInvocation,
) => {
  status: number | null;
  stdout?: string | Buffer;
  error?: Error;
};

export interface WindowsFileAuthorityOptions {
  anchorPath: string;
  platform?: NodeJS.Platform;
  systemRoot?: string;
  timeoutMs?: number;
}

export const WINDOWS_FILE_AUTHORITY_TEST_CONTROL = Symbol.for(
  'ashlr.windows-file-authority.test-control.v1',
);

export interface WindowsFileAuthorityTestControl {
  runner?: WindowsFileAuthorityRunner;
  observeInvocation?: (invocation: WindowsFileAuthorityInvocation) => void;
}

interface WindowsFileAuthorityTestControlState
  extends WindowsFileAuthorityTestControl {
  sentinel: symbol;
}

const TEST_CONTROL_STATE = Symbol.for(
  'ashlr.windows-file-authority.test-control.state.v1',
);

const FAILURE_REASONS = new Set([
  'adapter-error-apply-acl',
  'adapter-error-build-acl',
  'adapter-error-inspect-ancestors',
  'adapter-error-load-anchor',
  'adapter-error-load-item',
  'adapter-error-normalize-paths',
  'adapter-error-read-input',
  'adapter-error-read-item-acl',
  'adapter-error-reload-item',
  'adapter-error-verify-acl',
  'anchor-not-reached',
  'dacl-not-protected',
  'inherited-ace',
  'invalid-anchor',
  'invalid-input',
  'invalid-input-shape',
  'invalid-kind',
  'invalid-mode',
  'missing-or-duplicate-principal',
  'noncanonical-dacl',
  'null-dacl',
  'path-mismatch',
  'reparse-ancestor',
  'reparse-point',
  'unexpected-ace-count',
  'untrusted-ancestor-owner',
  'untrusted-ancestor-write',
  'untrusted-item-write',
  'wrong-access-type',
  'wrong-flags',
  'wrong-kind',
  'wrong-owner',
  'wrong-rights',
]);

const defaultRunner: WindowsFileAuthorityRunner = (invocation) => spawnSync(
  invocation.executable,
  invocation.args,
  {
    input: invocation.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: invocation.timeoutMs,
    maxBuffer: invocation.maxBuffer,
    windowsHide: true,
    shell: false,
  },
);

function isVitestContext(): boolean {
  return process.env['VITEST'] === 'true';
}

function activeTestControl(): WindowsFileAuthorityTestControlState | undefined {
  const state = Reflect.get(globalThis, TEST_CONTROL_STATE) as
    WindowsFileAuthorityTestControlState | undefined;
  if (state === undefined) return undefined;
  if (state.sentinel !== WINDOWS_FILE_AUTHORITY_TEST_CONTROL) {
    throw new Error('Invalid Windows file authority test control state');
  }
  if (!isVitestContext()) {
    throw new Error('Windows file authority test control is restricted to Vitest');
  }
  return state;
}

export function _setWindowsFileAuthorityTestControlForTest(
  sentinel: symbol,
  control: WindowsFileAuthorityTestControl | undefined,
): void {
  if (sentinel !== WINDOWS_FILE_AUTHORITY_TEST_CONTROL) {
    throw new Error('Invalid Windows file authority test control sentinel');
  }
  if (control === undefined) {
    Reflect.deleteProperty(globalThis, TEST_CONTROL_STATE);
    return;
  }
  if (!isVitestContext()) {
    throw new Error('Windows file authority test control is restricted to Vitest');
  }
  if (control.runner !== undefined && typeof control.runner !== 'function') {
    throw new TypeError('Windows file authority runner must be a function');
  }
  if (
    control.observeInvocation !== undefined &&
    typeof control.observeInvocation !== 'function'
  ) {
    throw new TypeError('Windows file authority invocation observer must be a function');
  }
  Reflect.set(globalThis, TEST_CONTROL_STATE, Object.freeze({
    sentinel: WINDOWS_FILE_AUTHORITY_TEST_CONTROL,
    runner: control.runner,
    observeInvocation: control.observeInvocation,
  } satisfies WindowsFileAuthorityTestControlState));
}

function localWindowsPath(value: string | undefined): string | null {
  if (
    !value ||
    value.length > MAX_PATH_LENGTH ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    return null;
  }
  try {
    const normalized = win32.normalize(value);
    if (!/^[A-Za-z]:\\/.test(normalized)) return null;
    if (normalized.slice(2).includes(':')) return null;
    return normalized;
  } catch {
    return null;
  }
}

function powershellPath(systemRoot: string | undefined): string | null {
  const root = localWindowsPath(systemRoot);
  return root
    ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : null;
}

function boundedTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
    ? Math.max(100, Math.min(15_000, Math.floor(timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
}

function canonicalResponse(
  nonce: string,
  ok: boolean,
  reason: string,
): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    operation: OPERATION,
    nonce,
    ok,
    reason,
  });
}

function parseResponse(
  stdout: string | Buffer | undefined,
  status: number | null,
  nonce: string,
  mode: WindowsFileAuthorityMode,
): WindowsFileAuthorityResult {
  const bytes = Buffer.isBuffer(stdout)
    ? Buffer.from(stdout)
    : Buffer.from(stdout ?? '', 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_OUTPUT_BYTES) {
    return { ok: false, reason: 'invalid-output' };
  }
  const text = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-output' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-output' };
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      'nonce,ok,operation,reason,schemaVersion' ||
    value['schemaVersion'] !== SCHEMA_VERSION ||
    value['operation'] !== OPERATION ||
    value['nonce'] !== nonce ||
    typeof value['ok'] !== 'boolean' ||
    typeof value['reason'] !== 'string' ||
    text !== canonicalResponse(
      nonce,
      value['ok'],
      value['reason'],
    )
  ) {
    return { ok: false, reason: 'invalid-output' };
  }
  const successReason = mode === 'validate' ? 'trusted-path' : 'hardened-path';
  if (status === 0) {
    return value['ok'] === true && value['reason'] === successReason
      ? { ok: true, reason: successReason }
      : { ok: false, reason: 'invalid-output' };
  }
  if (
    status === 1 &&
    value['ok'] === false &&
    FAILURE_REASONS.has(value['reason'])
  ) {
    return { ok: false, reason: value['reason'] };
  }
  return { ok: false, reason: 'adapter-failed' };
}

function runWindowsFileAuthority(
  targetPath: string,
  kind: WindowsFileAuthorityKind,
  mode: WindowsFileAuthorityMode,
  options: WindowsFileAuthorityOptions,
): WindowsFileAuthorityResult {
  if ((options.platform ?? process.platform) !== 'win32') {
    return { ok: false, reason: 'unsupported-platform' };
  }
  const path = localWindowsPath(targetPath);
  if (!path) return { ok: false, reason: 'invalid-path' };
  const anchorPath = localWindowsPath(options.anchorPath);
  if (!anchorPath) return { ok: false, reason: 'invalid-anchor' };
  const relative = win32.relative(anchorPath, path);
  if (
    relative === '..' ||
    relative.startsWith(`..${win32.sep}`) ||
    win32.isAbsolute(relative)
  ) {
    return { ok: false, reason: 'invalid-anchor' };
  }
  const executable = powershellPath(options.systemRoot ?? process.env.SystemRoot);
  if (!executable) return { ok: false, reason: 'powershell-unavailable' };

  const nonce = randomBytes(16).toString('hex');
  const input = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    operation: OPERATION,
    nonce,
    path,
    anchorPath,
    kind,
    mode,
  });
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    return { ok: false, reason: 'input-too-large' };
  }
  const invocation: WindowsFileAuthorityInvocation = {
    executable,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      ENCODED_WINDOWS_FILE_AUTHORITY_SCRIPT,
    ],
    input,
    timeoutMs: boundedTimeout(options.timeoutMs),
    maxBuffer: MAX_OUTPUT_BYTES,
  };
  const testControl = activeTestControl();
  try {
    testControl?.observeInvocation?.({
      ...invocation,
      args: [...invocation.args],
    });
    const result = (testControl?.runner ?? defaultRunner)(invocation);
    if (result.error) return { ok: false, reason: 'adapter-failed' };
    return parseResponse(result.stdout, result.status, nonce, mode);
  } catch {
    return { ok: false, reason: 'adapter-failed' };
  }
}

/** Validate an existing Windows service file or directory without mutating it. */
export function validateWindowsFileAuthority(
  path: string,
  kind: WindowsFileAuthorityKind,
  options: WindowsFileAuthorityOptions,
): WindowsFileAuthorityResult {
  return runWindowsFileAuthority(path, kind, 'validate', options);
}

/**
 * Replace a newly created path's inherited DACL with an exact private DACL,
 * then read it back before returning success.
 */
export function hardenWindowsFileAuthority(
  path: string,
  kind: WindowsFileAuthorityKind,
  options: WindowsFileAuthorityOptions,
): WindowsFileAuthorityResult {
  return runWindowsFileAuthority(path, kind, 'harden', options);
}
