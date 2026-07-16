import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';

const OPERATION = 'assure-private-path';
const MAX_OUTPUT_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BATCH_TIMEOUT_MS = 15_000;

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$stage = 'read-input'
function Finish([bool]$ok, [string]$reason) {
  [Console]::Out.Write((@{nonce=$request.nonce;operation='assure-private-path';ok=$ok;reason=$reason} | ConvertTo-Json -Compress))
  exit $(if ($ok) { 0 } else { 1 })
}
try {
  $raw = [Console]::In.ReadToEnd()
  $request = $raw | ConvertFrom-Json
  $keys = @($request.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ',') -ne 'anchorPath,kind,mode,nonce,operation,path,schemaVersion') { Finish $false 'invalid-input-shape' }
  if ($request.schemaVersion -ne 1 -or $request.operation -ne 'assure-private-path') { Finish $false 'invalid-input' }
  if ($request.kind -ne 'file' -and $request.kind -ne 'directory') { Finish $false 'invalid-kind' }
  if ($request.mode -ne 'secure-created' -and $request.mode -ne 'inspect-existing' -and $request.mode -ne 'inspect-owned') { Finish $false 'invalid-mode' }
  $stage = 'load-item'
  $item = Get-Item -LiteralPath $request.path -Force
  $anchor = Get-Item -LiteralPath $request.anchorPath -Force
  if (-not $anchor.PSIsContainer -or
    ($anchor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Finish $false 'invalid-anchor' }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Finish $false 'reparse-point' }
  if ($request.kind -eq 'file' -and $item.PSIsContainer) { Finish $false 'wrong-kind' }
  if ($request.kind -eq 'directory' -and -not $item.PSIsContainer) { Finish $false 'wrong-kind' }
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $trustedSids = @($current.Value, $system.Value, $administrators.Value)
  $cursor = if ($request.kind -eq 'file') { $item.Directory } else { $item.Parent }
  $stage = 'inspect-ancestors'
  $reachedAnchor = $false
  while ($null -ne $cursor) {
    $stage = 'ancestor-parent'
    $ancestorParent = $cursor.Parent
    $stage = 'ancestor-attributes'
    if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Finish $false 'reparse-ancestor' }
    $stage = 'ancestor-get-acl'
    $ancestorAcl = $cursor.GetAccessControl()
    $stage = 'ancestor-owner'
    $ancestorOwner = $ancestorAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($trustedSids -notcontains $ancestorOwner) { Finish $false 'untrusted-ancestor-owner' }
    $stage = 'ancestor-rules'
    $ancestorRules = @($ancestorAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    foreach ($ancestorRule in $ancestorRules) {
      $inheritOnly = (([int]$ancestorRule.PropagationFlags -band 2) -ne 0)
      $canReplaceChild = (([int]$ancestorRule.FileSystemRights -band 64) -ne 0) -or
        (([int]$ancestorRule.FileSystemRights -band 2) -ne 0) -or
        (([int]$ancestorRule.FileSystemRights -band 4) -ne 0) -or
        (([int]$ancestorRule.FileSystemRights -band 65536) -ne 0) -or
        (([int]$ancestorRule.FileSystemRights -band 262144) -ne 0) -or
        (([int]$ancestorRule.FileSystemRights -band 524288) -ne 0)
      if ($ancestorRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        -not $inheritOnly -and $canReplaceChild -and
        $trustedSids -notcontains $ancestorRule.IdentityReference.Value) {
        Finish $false 'untrusted-ancestor-delete'
      }
    }
    if ($cursor.FullName -eq $anchor.FullName) {
      $reachedAnchor = $true
      break
    }
    $stage = 'ancestor-next'
    $cursor = $ancestorParent
  }
  if (-not $reachedAnchor) { Finish $false 'anchor-not-reached' }
  $stage = 'read-owner'
  $itemAcl = $item.GetAccessControl()
  if ($request.mode -ne 'secure-created' -and
    $itemAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { Finish $false 'wrong-owner' }
  if ($request.mode -eq 'inspect-owned') {
    $itemRules = @($itemAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    foreach ($itemRule in $itemRules) {
      $canMutateItem = (([int]$itemRule.FileSystemRights -band 2) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 4) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 16) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 256) -ne 0) -or
        (($request.kind -eq 'directory') -and (([int]$itemRule.FileSystemRights -band 64) -ne 0)) -or
        (([int]$itemRule.FileSystemRights -band 65536) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 262144) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 524288) -ne 0)
      if ($itemRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $canMutateItem -and $trustedSids -notcontains $itemRule.IdentityReference.Value) {
        Finish $false 'untrusted-item-write'
      }
    }
    Finish $true 'owned-safe-path'
  }
  $principalValues = @($current.Value, $system.Value) | Select-Object -Unique
  if ($request.mode -eq 'secure-created') {
    $stage = 'build-acl'
    if ($request.kind -eq 'file') {
      $security = [System.Security.AccessControl.FileSecurity]::new()
      $flags = [System.Security.AccessControl.InheritanceFlags]::None
    } else {
      $security = [System.Security.AccessControl.DirectorySecurity]::new()
      $flags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    $security.SetOwner($current)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in $principalValues) {
      $sid = [System.Security.Principal.SecurityIdentifier]::new($sidValue)
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $flags,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
      [void]$security.AddAccessRule($rule)
    }
    $stage = 'apply-acl'
    $item.SetAccessControl($security)
  }
  $stage = 'readback-acl'
  $item.Refresh()
  $acl = $item.GetAccessControl()
  if (-not $acl.AreAccessRulesProtected) { Finish $false 'dacl-not-protected' }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { Finish $false 'wrong-owner' }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne $principalValues.Count) { Finish $false 'unexpected-ace-count' }
  $expectedFlags = if ($request.kind -eq 'file') { 0 } else { 3 }
  foreach ($sid in $principalValues) {
    $stage = 'verify-acl'
    $matches = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid })
    if ($matches.Count -ne 1) { Finish $false 'missing-or-duplicate-principal' }
    $rule = $matches[0]
    if ($rule.IsInherited) { Finish $false 'inherited-ace' }
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { Finish $false 'deny-ace' }
    if ([int]$rule.FileSystemRights -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl) { Finish $false 'wrong-rights' }
    if ([int]$rule.InheritanceFlags -ne $expectedFlags -or [int]$rule.PropagationFlags -ne 0) { Finish $false 'wrong-flags' }
  }
  Finish $true 'exact-private-dacl'
} catch {
  if ($null -eq $request) {
    $request = @{nonce='invalid'}
  }
  Finish $false ('adapter-error-' + $stage)
}
`;

const ENCODED_WINDOWS_ACL_SCRIPT = Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64');

const WINDOWS_OWNED_BATCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$stage = 'read-input'
function Finish([bool]$ok, [string]$reason) {
  [Console]::Out.Write((@{nonce=$request.nonce;operation='assure-private-paths';ok=$ok;reason=$reason} | ConvertTo-Json -Compress))
  exit $(if ($ok) { 0 } else { 1 })
}
try {
  $request = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
  $keys = @($request.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ',') -ne 'anchorPath,kind,nonce,operation,paths,schemaVersion') { Finish $false 'invalid-input-shape' }
  if ($request.schemaVersion -ne 1 -or $request.operation -ne 'assure-private-paths') { Finish $false 'invalid-input' }
  if ($request.kind -ne 'file') { Finish $false 'invalid-kind' }
  $paths = @($request.paths)
  if ($paths.Count -lt 1 -or $paths.Count -gt 512) { Finish $false 'invalid-input' }
  $anchor = Get-Item -LiteralPath $request.anchorPath -Force
  if (-not $anchor.PSIsContainer -or ($anchor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Finish $false 'invalid-anchor' }
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $trustedSids = @($current.Value, $system.Value, $administrators.Value)
  foreach ($candidatePath in $paths) {
    $stage = 'load-item'
    $item = Get-Item -LiteralPath $candidatePath -Force
    if ($item.PSIsContainer) { Finish $false 'wrong-kind' }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Finish $false 'reparse-point' }
    $itemAcl = $item.GetAccessControl()
    if ($itemAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { Finish $false 'wrong-owner' }
    $itemRules = @($itemAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    foreach ($itemRule in $itemRules) {
      $canMutateItem = (([int]$itemRule.FileSystemRights -band 2) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 4) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 16) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 256) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 65536) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 262144) -ne 0) -or
        (([int]$itemRule.FileSystemRights -band 524288) -ne 0)
      if ($itemRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $canMutateItem -and $trustedSids -notcontains $itemRule.IdentityReference.Value) { Finish $false 'untrusted-item-write' }
    }
    $cursor = $item.Directory
    $reachedAnchor = $false
    while ($null -ne $cursor) {
      $ancestorParent = $cursor.Parent
      if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Finish $false 'reparse-ancestor' }
      $ancestorAcl = $cursor.GetAccessControl()
      if ($trustedSids -notcontains $ancestorAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { Finish $false 'untrusted-ancestor-owner' }
      $ancestorRules = @($ancestorAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
      foreach ($ancestorRule in $ancestorRules) {
        $inheritOnly = (([int]$ancestorRule.PropagationFlags -band 2) -ne 0)
        $canReplaceChild = (([int]$ancestorRule.FileSystemRights -band 2) -ne 0) -or
          (([int]$ancestorRule.FileSystemRights -band 4) -ne 0) -or
          (([int]$ancestorRule.FileSystemRights -band 64) -ne 0) -or
          (([int]$ancestorRule.FileSystemRights -band 65536) -ne 0) -or
          (([int]$ancestorRule.FileSystemRights -band 262144) -ne 0) -or
          (([int]$ancestorRule.FileSystemRights -band 524288) -ne 0)
        if ($ancestorRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
          -not $inheritOnly -and $canReplaceChild -and $trustedSids -notcontains $ancestorRule.IdentityReference.Value) { Finish $false 'untrusted-ancestor-delete' }
      }
      if ($cursor.FullName -eq $anchor.FullName) { $reachedAnchor = $true; break }
      $cursor = $ancestorParent
    }
    if (-not $reachedAnchor) { Finish $false 'anchor-not-reached' }
  }
  Finish $true 'owned-safe-paths'
} catch {
  if ($null -eq $request) { $request = @{nonce='invalid'} }
  Finish $false ('adapter-error-' + $stage)
}
`;

const ENCODED_WINDOWS_OWNED_BATCH_SCRIPT = Buffer.from(
  WINDOWS_OWNED_BATCH_SCRIPT,
  'utf16le',
).toString('base64');

export type PrivateStorageKind = 'file' | 'directory';
export type PrivateStorageMode = 'secure-created' | 'inspect-existing' | 'inspect-owned';

export interface PrivateStorageAssurance {
  ok: boolean;
  reason: string;
}

export interface PrivateStorageInvocation {
  executable: string;
  args: string[];
  input: string;
  timeoutMs: number;
  maxBuffer: number;
}

export type PrivateStorageRunner = (invocation: PrivateStorageInvocation) => {
  status: number | null;
  stdout?: string | Buffer;
  error?: Error;
};

const FAILURE_REASONS = new Set([
  'adapter-error-ancestor-attributes', 'adapter-error-ancestor-get-acl',
  'adapter-error-ancestor-next', 'adapter-error-ancestor-owner',
  'adapter-error-ancestor-parent', 'adapter-error-ancestor-rules',
  'adapter-error-apply-acl', 'adapter-error-build-acl', 'adapter-error-inspect-ancestors',
  'adapter-error-load-item', 'adapter-error-read-input', 'adapter-error-readback-acl',
  'adapter-error-verify-acl', 'anchor-not-reached', 'dacl-not-protected', 'deny-ace',
  'inherited-ace', 'invalid-anchor', 'invalid-input', 'invalid-input-shape', 'invalid-kind',
  'invalid-mode', 'missing-or-duplicate-principal',
  'reparse-ancestor', 'reparse-point', 'unexpected-ace-count', 'untrusted-ancestor-delete',
  'untrusted-ancestor-owner', 'untrusted-item-write', 'wrong-flags', 'wrong-kind',
  'wrong-owner', 'wrong-rights',
]);

const defaultRunner: PrivateStorageRunner = (invocation) => spawnSync(
  invocation.executable,
  invocation.args,
  {
    input: invocation.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: invocation.timeoutMs,
    maxBuffer: invocation.maxBuffer,
    windowsHide: true,
    shell: false,
  },
);

function localWindowsPath(value: string | undefined, maxLength: number): string | null {
  if (!value || value.length > maxLength || [...value].some((char) => char.charCodeAt(0) < 32)) return null;
  try {
    const normalized = win32.normalize(value);
    return /^[A-Za-z]:\\/.test(normalized) ? normalized : null;
  } catch { return null; }
}

function powershellPath(systemRoot: string | undefined): string | null {
  const root = localWindowsPath(systemRoot, 1_024);
  return root ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
}

/**
 * Apply or inspect an exact current-user + SYSTEM protected Windows DACL.
 * Paths are carried only in bounded JSON stdin; executable and argv are fixed.
 */
export function assurePrivateStoragePath(
  path: string,
  kind: PrivateStorageKind,
  mode: PrivateStorageMode,
  options: {
    platform?: NodeJS.Platform;
    systemRoot?: string;
    anchorPath?: string;
    timeoutMs?: number;
    runner?: PrivateStorageRunner;
  } = {},
): PrivateStorageAssurance {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { ok: true, reason: 'posix-checked-by-caller' };
  const privatePath = localWindowsPath(path, 4_096);
  if (!privatePath) return { ok: false, reason: 'invalid-path' };
  const anchorPath = localWindowsPath(options.anchorPath, 4_096);
  if (!anchorPath) return { ok: false, reason: 'invalid-anchor' };
  const relative = win32.relative(anchorPath, privatePath);
  if (relative === '..' || relative.startsWith(`..${win32.sep}`) || win32.isAbsolute(relative)) {
    return { ok: false, reason: 'invalid-anchor' };
  }
  const executable = powershellPath(options.systemRoot ?? process.env.SystemRoot);
  if (!executable) return { ok: false, reason: 'powershell-unavailable' };
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.max(100, Math.min(15_000, Math.floor(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
  const nonce = randomBytes(16).toString('hex');
  const input = JSON.stringify({
    schemaVersion: 1,
    operation: OPERATION,
    nonce,
    path: privatePath,
    anchorPath,
    kind,
    mode,
  });
  try {
    const result = (options.runner ?? defaultRunner)({
      executable,
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', ENCODED_WINDOWS_ACL_SCRIPT,
      ],
      input,
      timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.error) return { ok: false, reason: 'adapter-failed' };
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout ?? '';
    if (!stdout || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) return { ok: false, reason: 'invalid-output' };
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(',') !== 'nonce,ok,operation,reason' ||
      parsed['nonce'] !== nonce || parsed['operation'] !== OPERATION ||
      typeof parsed['reason'] !== 'string') return { ok: false, reason: 'invalid-output' };
    if (result.status !== 0) {
      return parsed['ok'] === false && FAILURE_REASONS.has(parsed['reason'])
        ? { ok: false, reason: parsed['reason'] }
        : { ok: false, reason: 'adapter-failed' };
    }
    const expectedReason = mode === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl';
    if (parsed['ok'] !== true || parsed['reason'] !== expectedReason) {
      return { ok: false, reason: 'invalid-output' };
    }
    return { ok: true, reason: expectedReason };
  } catch {
    return { ok: false, reason: 'adapter-failed' };
  }
}

/** Inspect up to 512 existing Windows files in one authenticated PowerShell call. */
export function assurePrivateStoragePaths(
  paths: string[],
  options: {
    platform?: NodeJS.Platform;
    systemRoot?: string;
    anchorPath?: string;
    timeoutMs?: number;
    runner?: PrivateStorageRunner;
  } = {},
): PrivateStorageAssurance {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { ok: true, reason: 'posix-checked-by-caller' };
  if (paths.length === 0) return { ok: true, reason: 'no-paths' };
  if (paths.length > 512) return { ok: false, reason: 'too-many-paths' };
  const privatePaths = paths.map((candidate) => localWindowsPath(candidate, 4_096));
  if (privatePaths.some((candidate) => candidate === null)) {
    return { ok: false, reason: 'invalid-path' };
  }
  const anchorPath = localWindowsPath(options.anchorPath, 4_096);
  if (!anchorPath) return { ok: false, reason: 'invalid-anchor' };
  for (const privatePath of privatePaths as string[]) {
    const nested = win32.relative(anchorPath, privatePath);
    if (nested === '..' || nested.startsWith(`..${win32.sep}`) || win32.isAbsolute(nested)) {
      return { ok: false, reason: 'invalid-anchor' };
    }
  }
  const executable = powershellPath(options.systemRoot ?? process.env.SystemRoot);
  if (!executable) return { ok: false, reason: 'powershell-unavailable' };
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.max(100, Math.min(15_000, Math.floor(options.timeoutMs)))
    : DEFAULT_BATCH_TIMEOUT_MS;
  const nonce = randomBytes(16).toString('hex');
  const operation = 'assure-private-paths';
  const input = JSON.stringify({
    schemaVersion: 1,
    operation,
    nonce,
    paths: privatePaths,
    anchorPath,
    kind: 'file',
  });
  if (Buffer.byteLength(input, 'utf8') > 2 * 1024 * 1024) {
    return { ok: false, reason: 'input-too-large' };
  }
  try {
    const result = (options.runner ?? defaultRunner)({
      executable,
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', ENCODED_WINDOWS_OWNED_BATCH_SCRIPT,
      ],
      input,
      timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.error) return { ok: false, reason: 'adapter-failed' };
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout ?? '';
    if (!stdout || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
      return { ok: false, reason: 'invalid-output' };
    }
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(',') !== 'nonce,ok,operation,reason' ||
      parsed['nonce'] !== nonce || parsed['operation'] !== operation ||
      typeof parsed['reason'] !== 'string') return { ok: false, reason: 'invalid-output' };
    if (result.status !== 0) {
      return parsed['ok'] === false && FAILURE_REASONS.has(parsed['reason'])
        ? { ok: false, reason: parsed['reason'] }
        : { ok: false, reason: 'adapter-failed' };
    }
    return parsed['ok'] === true && parsed['reason'] === 'owned-safe-paths'
      ? { ok: true, reason: 'owned-safe-paths' }
      : { ok: false, reason: 'invalid-output' };
  } catch {
    return { ok: false, reason: 'adapter-failed' };
  }
}
