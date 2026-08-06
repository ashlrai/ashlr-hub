import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWindowsTaskCreateScript,
  buildWindowsTaskRestoreScript,
  buildWindowsTaskRunScript,
  buildWindowsTaskSnapshotScript,
  buildWindowsTaskStopDeleteScript,
  windowsPowerShellPath,
} from '../src/core/daemon/windows-task-scripts.js';

const TASK_PREFIX = 'AshlrM93Integration-';
const POWERSHELL_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_POWERSHELL_SCRIPT_CHARACTERS = 30_000;

const CLEANUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 4096) {
  throw 'request exceeded input limit'
}
$request = $raw | ConvertFrom-Json
$properties = @($request.PSObject.Properties.Name)
if ($properties.Count -ne 1 -or $properties[0] -cne 'taskName') {
  throw 'request shape was not exact'
}
$taskName = [string]$request.taskName
if (
  $taskName -ceq 'AshlrDaemon' -or
  -not $taskName.StartsWith('AshlrM93Integration-', [StringComparison]::Ordinal) -or
  $taskName.Length -gt 96 -or
  $taskName -notmatch '^AshlrM93Integration-[a-f0-9-]+$'
) {
  throw 'task name was outside the disposable integration-test namespace'
}
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
try {
  $matches = @($folder.GetTasks(1) | Where-Object { $_.Name -ceq $taskName })
  if ($matches.Count -gt 1) {
    throw 'cleanup found ambiguous disposable task authority'
  }
  if ($matches.Count -eq 1) {
    $task = $matches[0]
  } else {
    $task = $null
  }
  if ($null -ne $task) {
  if (@(2,4) -contains [int]$task.State) {
    $task.Stop(0)
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
      Start-Sleep -Milliseconds 100
      $task = $folder.GetTask($taskName)
      if (@(2,4) -notcontains [int]$task.State) {
        break
      }
    }
  }
  $folder.DeleteTask($taskName, 0)
  }
} catch {
  throw
}
`;

const CREATE_ARGUMENT_TASK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
$request = $raw | ConvertFrom-Json
$properties = @($request.PSObject.Properties.Name | Sort-Object)
if (($properties -join ',') -cne 'launcherPath,taskName') {
  throw 'request shape was not exact'
}
$taskName = [string]$request.taskName
if (
  $taskName -ceq 'AshlrDaemon' -or
  -not $taskName.StartsWith('AshlrM93Integration-', [StringComparison]::Ordinal) -or
  $taskName.Length -gt 96 -or
  $taskName -notmatch '^AshlrM93Integration-[a-f0-9-]+$'
) {
  throw 'task name was outside the disposable integration-test namespace'
}
$launcherPath = [IO.Path]::GetFullPath([string]$request.launcherPath)
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$definition = $service.NewTask(0)
$definition.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$trigger = $definition.Triggers.Create(9)
$trigger.Enabled = $true
$action = $definition.Actions.Create(0)
$action.Path = $launcherPath
$action.Arguments = 'unexpected'
[void]$folder.RegisterTaskDefinition($taskName, $definition, 2, $null, $null, 3, $null)
`;

const ADD_UNTRUSTED_WRITE_ACE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 4096) {
  throw 'request exceeded input limit'
}
$request = $raw | ConvertFrom-Json
$properties = @($request.PSObject.Properties.Name)
if ($properties.Count -ne 1 -or $properties[0] -cne 'taskName') {
  throw 'request shape was not exact'
}
$taskName = [string]$request.taskName
if (
  $taskName -ceq 'AshlrDaemon' -or
  -not $taskName.StartsWith('AshlrM93Integration-', [StringComparison]::Ordinal) -or
  $taskName.Length -gt 96 -or
  $taskName -notmatch '^AshlrM93Integration-[a-f0-9-]+$'
) {
  throw 'task name was outside the disposable integration-test namespace'
}
function Get-AllowMask(
  [Security.AccessControl.RawSecurityDescriptor]$descriptor,
  [string]$sid
) {
  [uint64]$mask = 0
  for ($index = 0; $index -lt $descriptor.DiscretionaryAcl.Count; $index++) {
    $ace = $descriptor.DiscretionaryAcl[$index]
    if (
      $ace -is [Security.AccessControl.CommonAce] -and
      $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
      $ace.SecurityIdentifier.Value -ceq $sid
    ) {
      $bytes = [BitConverter]::GetBytes([int]$ace.AccessMask)
      $mask = $mask -bor [uint64][BitConverter]::ToUInt32($bytes, 0)
    }
  }
  return $mask
}
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$registered = $folder.GetTask($taskName)
$before = [Security.AccessControl.RawSecurityDescriptor]::new(
  [string]$registered.GetSecurityDescriptor(7)
)
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$systemSid = 'S-1-5-18'
$ownerBefore = $before.Owner.Value
$currentMaskBefore = Get-AllowMask $before $currentSid
$systemMaskBefore = Get-AllowMask $before $systemSid
if ($currentMaskBefore -eq 0 -or $systemMaskBefore -eq 0) {
  throw 'trusted task control was missing before mutation'
}
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$writeDac = [int]0x00040000
$untrustedAce = [Security.AccessControl.CommonAce]::new(
  [Security.AccessControl.AceFlags]::None,
  [Security.AccessControl.AceQualifier]::AccessAllowed,
  $writeDac,
  $everyone,
  $false,
  $null
)
$before.DiscretionaryAcl.InsertAce($before.DiscretionaryAcl.Count, $untrustedAce)
$mutatedSddl = $before.GetSddlForm(
  [Security.AccessControl.AccessControlSections]7
)
$registered.SetSecurityDescriptor($mutatedSddl, 0)
$after = [Security.AccessControl.RawSecurityDescriptor]::new(
  [string]$registered.GetSecurityDescriptor(7)
)
if ($after.Owner.Value -cne $ownerBefore) {
  throw 'task owner changed during mutation'
}
$currentMaskAfter = Get-AllowMask $after $currentSid
$systemMaskAfter = Get-AllowMask $after $systemSid
if (
  ($currentMaskAfter -band $currentMaskBefore) -ne $currentMaskBefore -or
  ($systemMaskAfter -band $systemMaskBefore) -ne $systemMaskBefore
) {
  throw 'trusted task control changed during mutation'
}
$everyoneMaskAfter = Get-AllowMask $after $everyone.Value
if (($everyoneMaskAfter -band [uint64]$writeDac) -eq 0) {
  throw 'untrusted write-capable ACE was not registered'
}
[Console]::Out.Write('mutated')
`;

interface TaskSnapshot {
  state: string;
  taskXmlBase64: string;
  taskSecurityDescriptorBase64: string;
}

function parseTaskSnapshot(result: ReturnType<typeof runPowerShellInput>): TaskSnapshot {
  if (result.status !== 0 || result.error) throw commandFailure('Task Scheduler snapshot', result);
  const parsed = JSON.parse(result.stdout) as TaskSnapshot;
  expect(result.stdout).toBe(JSON.stringify(parsed));
  return parsed;
}

function sha256Base64(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');
}

function replaceTaskXmlValue(
  taskXmlBase64: string,
  expected: string,
  replacement: string,
): string {
  const taskXml = Buffer.from(taskXmlBase64, 'base64').toString('utf8');
  expect(taskXml.split(expected)).toHaveLength(2);
  return Buffer.from(taskXml.replace(expected, replacement), 'utf8').toString('base64');
}

function runPowerShellInput(script: string, input: Record<string, string>) {
  if (script.length >= MAX_POWERSHELL_SCRIPT_CHARACTERS) {
    throw new Error('PowerShell script must contain fewer than 30000 characters');
  }
  const executable = windowsPowerShellPath();
  if (!existsSync(executable)) {
    throw new Error(`Windows PowerShell executable was not found at ${executable}`);
  }
  return spawnSync(
    executable,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify(input),
      maxBuffer: MAX_STDOUT_BYTES,
      shell: false,
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true,
    },
  );
}

function runPowerShell(script: string, taskName: string) {
  return runPowerShellInput(script, { taskName });
}

function commandFailure(label: string, result: ReturnType<typeof runPowerShell>): Error {
  const detail = result.error?.message
    ?? result.stderr.trim()
    ?? `exit status ${String(result.status)}`;
  return new Error(`${label} failed: ${detail}`);
}

function createDisposableTask(taskName: string, launcherPath: string): void {
  expect(taskName).toMatch(/^AshlrM93Integration-/);
  const created = runPowerShellInput(
    buildWindowsTaskCreateScript(taskName),
    { expectedLauncherPath: launcherPath },
  );
  if (created.status !== 0 || created.error) {
    throw commandFailure('production disposable task creation', created);
  }
  expect(created.stdout).toBe('created');
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitUntil(predicate: () => boolean): boolean {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return true;
    sleep(100);
  }
  return false;
}

describe('M93 native Windows Task Scheduler integration harness', () => {
  it('rejects scripts at the Windows command-line ceiling before process creation', () => {
    expect(() => runPowerShellInput(
      'x'.repeat(MAX_POWERSHELL_SCRIPT_CHARACTERS),
      {},
    )).toThrow('PowerShell script must contain fewer than 30000 characters');
  });
});

describe.skipIf(process.platform !== 'win32')(
  'M93 native Windows Task Scheduler integration',
  () => {
    it('round-trips and runs the generated schema through all production Task Scheduler scripts', () => {
      const taskName = `${TASK_PREFIX}${process.pid}-${randomUUID()}`;
      const scratch = mkdtempSync(join(tmpdir(), 'ashlr-m93-task-run-'));
      const launcherPath = join(scratch, 'ashlr-daemon.cmd');
      const sentinelPath = join(scratch, 'started.txt');
      let testFailure: unknown;
      let cleanupFailure: Error | undefined;
      writeFileSync(
        launcherPath,
        `@echo off\r\n> "${sentinelPath}" echo started\r\n`,
        { mode: 0o600 },
      );

      try {
        createDisposableTask(taskName, launcherPath);

        const before = parseTaskSnapshot(runPowerShellInput(
          buildWindowsTaskSnapshotScript(taskName),
          { expectedLauncherPath: launcherPath },
        ));
        const taskXmlSha256 = sha256Base64(before.taskXmlBase64);
        const taskSecurityDescriptorSha256 = sha256Base64(
          before.taskSecurityDescriptorBase64,
        );

        const deleted = runPowerShellInput(
          buildWindowsTaskStopDeleteScript(taskName),
          {
            expectedLauncherPath: launcherPath,
            taskXmlSha256,
            taskSecurityDescriptorSha256,
          },
        );
        if (deleted.status !== 0 || deleted.error) {
          throw commandFailure('production authority-bound deletion', deleted);
        }
        expect(deleted.stdout).toBe('deleted');

        for (const [expected, replacement] of [
          ['<Duration>PT10M</Duration>', '<Duration>PT11M</Duration>'],
          ['<WaitTimeout>PT1H</WaitTimeout>', '<WaitTimeout>PT2H</WaitTimeout>'],
          ['<Interval>PT1M</Interval>', '<Interval>PT2M</Interval>'],
          ['<Count>3</Count>', '<Count>4</Count>'],
          ['G:SYD:P', 'G:BAD:P'],
        ]) {
          const rejected = runPowerShellInput(
            buildWindowsTaskRestoreScript(taskName),
            {
              expectedLauncherPath: launcherPath,
              taskXmlBase64: replaceTaskXmlValue(
                before.taskXmlBase64,
                expected,
                replacement,
              ),
              taskSecurityDescriptorBase64: before.taskSecurityDescriptorBase64,
            },
          );
          expect(rejected.status).not.toBe(0);
          expect(rejected.error).toBeUndefined();
          const stillAbsent = runPowerShellInput(
            buildWindowsTaskSnapshotScript(taskName),
            { expectedLauncherPath: launcherPath },
          );
          expect(stillAbsent.status).toBe(0);
          expect(stillAbsent.stdout).toBe('absent');
        }

        const restored = runPowerShellInput(
          buildWindowsTaskRestoreScript(taskName),
          {
            expectedLauncherPath: launcherPath,
            taskXmlBase64: before.taskXmlBase64,
            taskSecurityDescriptorBase64: before.taskSecurityDescriptorBase64,
          },
        );
        if (restored.status !== 0 || restored.error) {
          throw commandFailure('production authority-bound restoration', restored);
        }
        expect(restored.stdout).toBe('restored');

        const after = parseTaskSnapshot(runPowerShellInput(
          buildWindowsTaskSnapshotScript(taskName),
          { expectedLauncherPath: launcherPath },
        ));
        expect(after).toEqual(before);
        expect(sha256Base64(after.taskXmlBase64)).toBe(taskXmlSha256);
        expect(sha256Base64(after.taskSecurityDescriptorBase64))
          .toBe(taskSecurityDescriptorSha256);

        const activated = runPowerShellInput(
          buildWindowsTaskRunScript(taskName),
          { expectedLauncherPath: launcherPath },
        );
        if (activated.status !== 0 || activated.error) {
          throw commandFailure('production authority-bound activation', activated);
        }
        expect(activated.stdout).toBe('started');
        for (let attempt = 0; attempt < 50 && !existsSync(sentinelPath); attempt++) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
        expect(existsSync(sentinelPath)).toBe(true);
        expect(readFileSync(sentinelPath, 'utf8').trim()).toBe('started');
      } catch (error) {
        testFailure = error;
      } finally {
        const cleanup = runPowerShell(CLEANUP_SCRIPT, taskName);
        if (cleanup.status !== 0 || cleanup.error) {
          cleanupFailure = commandFailure('Task Scheduler activation cleanup', cleanup);
        }
        rmSync(scratch, { recursive: true, force: true });
      }
      if (testFailure) throw testFailure;
      if (cleanupFailure) throw cleanupFailure;
    }, POWERSHELL_TIMEOUT_MS * 6);

    it('stops a running disposable launcher before digest-bound deletion', () => {
      const taskName = `${TASK_PREFIX}${process.pid}-${randomUUID()}`;
      const scratch = mkdtempSync(join(tmpdir(), 'ashlr-m93-task-stop-'));
      const launcherPath = join(scratch, 'ashlr-daemon.cmd');
      const heartbeatPath = join(scratch, 'heartbeat.txt');
      let testFailure: unknown;
      let cleanupFailure: Error | undefined;
      writeFileSync(
        launcherPath,
        [
          '@echo off',
          ':heartbeat',
          `>> "${heartbeatPath}" echo heartbeat`,
          'ping.exe -n 2 127.0.0.1 >nul',
          'goto heartbeat',
          '',
        ].join('\r\n'),
        { mode: 0o600 },
      );

      try {
        createDisposableTask(taskName, launcherPath);
        const before = parseTaskSnapshot(runPowerShellInput(
          buildWindowsTaskSnapshotScript(taskName),
          { expectedLauncherPath: launcherPath },
        ));
        const activated = runPowerShellInput(
          buildWindowsTaskRunScript(taskName),
          { expectedLauncherPath: launcherPath },
        );
        if (activated.status !== 0 || activated.error) {
          throw commandFailure('blocking disposable task activation', activated);
        }
        expect(activated.stdout).toBe('started');
        expect(waitUntil(() => {
          if (!existsSync(heartbeatPath)) return false;
          return readFileSync(heartbeatPath, 'utf8').trim().split(/\r?\n/).length >= 2;
        })).toBe(true);
        const running = parseTaskSnapshot(runPowerShellInput(
          buildWindowsTaskSnapshotScript(taskName),
          { expectedLauncherPath: launcherPath },
        ));
        expect(running).toEqual({ ...before, state: '4' });

        const deleted = runPowerShellInput(
          buildWindowsTaskStopDeleteScript(taskName),
          {
            expectedLauncherPath: launcherPath,
            taskXmlSha256: sha256Base64(running.taskXmlBase64),
            taskSecurityDescriptorSha256: sha256Base64(
              running.taskSecurityDescriptorBase64,
            ),
          },
        );
        if (deleted.status !== 0 || deleted.error) {
          throw commandFailure('running disposable task deletion', deleted);
        }
        expect(deleted.stdout).toBe('deleted');
        const absent = runPowerShellInput(
          buildWindowsTaskSnapshotScript(taskName),
          { expectedLauncherPath: launcherPath },
        );
        if (absent.status !== 0 || absent.error) {
          throw commandFailure('deleted disposable task verification', absent);
        }
        expect(absent.stdout).toBe('absent');

        sleep(1_500);
        const stoppedHeartbeat = readFileSync(heartbeatPath, 'utf8');
        sleep(1_500);
        expect(readFileSync(heartbeatPath, 'utf8')).toBe(stoppedHeartbeat);
      } catch (error) {
        testFailure = error;
      } finally {
        const cleanup = runPowerShell(CLEANUP_SCRIPT, taskName);
        if (cleanup.status !== 0 || cleanup.error) {
          cleanupFailure = commandFailure('running task cleanup', cleanup);
        }
        rmSync(scratch, { recursive: true, force: true });
      }
      if (testFailure) throw testFailure;
      if (cleanupFailure) throw cleanupFailure;
    }, POWERSHELL_TIMEOUT_MS * 5);

    it('retains a disposable task when removal receives a stale snapshot digest', () => {
      const taskName = `${TASK_PREFIX}${process.pid}-${randomUUID()}`;
      const scratch = mkdtempSync(join(tmpdir(), 'ashlr-m93-task-stale-'));
      const launcherPath = join(scratch, 'ashlr-daemon.cmd');
      let testFailure: unknown;
      let cleanupFailure: Error | undefined;
      writeFileSync(launcherPath, '@echo off\r\nexit /b 0\r\n', { mode: 0o600 });

      try {
        createDisposableTask(taskName, launcherPath);
        const before = parseTaskSnapshot(runPowerShellInput(
          buildWindowsTaskSnapshotScript(taskName),
          { expectedLauncherPath: launcherPath },
        ));
        const currentDigest = sha256Base64(before.taskXmlBase64);
        const staleDigest = `${currentDigest[0] === '0' ? '1' : '0'}${currentDigest.slice(1)}`;
        const refused = runPowerShellInput(
          buildWindowsTaskStopDeleteScript(taskName),
          {
            expectedLauncherPath: launcherPath,
            taskXmlSha256: staleDigest,
            taskSecurityDescriptorSha256: sha256Base64(
              before.taskSecurityDescriptorBase64,
            ),
          },
        );
        expect(refused.status !== 0 || refused.error).toBe(true);
        expect(refused.stdout).not.toBe('deleted');
        expect(refused.stderr).toContain('task identity changed before removal');

        const after = parseTaskSnapshot(runPowerShellInput(
          buildWindowsTaskSnapshotScript(taskName),
          { expectedLauncherPath: launcherPath },
        ));
        expect(after).toEqual(before);
      } catch (error) {
        testFailure = error;
      } finally {
        const cleanup = runPowerShell(CLEANUP_SCRIPT, taskName);
        if (cleanup.status !== 0 || cleanup.error) {
          cleanupFailure = commandFailure('stale digest task cleanup', cleanup);
        }
        rmSync(scratch, { recursive: true, force: true });
      }
      if (testFailure) throw testFailure;
      if (cleanupFailure) throw cleanupFailure;
    }, POWERSHELL_TIMEOUT_MS * 4);

    it('refuses create-only restoration over an existing disposable task', () => {
      const taskName = `${TASK_PREFIX}${process.pid}-${randomUUID()}`;
      const scratch = mkdtempSync(join(tmpdir(), 'ashlr-m93-task-restore-'));
      const launcherPath = join(scratch, 'ashlr-daemon.cmd');
      let testFailure: unknown;
      let cleanupFailure: Error | undefined;
      writeFileSync(launcherPath, '@echo off\r\nexit /b 0\r\n', { mode: 0o600 });

      try {
        createDisposableTask(taskName, launcherPath);
        const before = parseTaskSnapshot(runPowerShellInput(
          buildWindowsTaskSnapshotScript(taskName),
          { expectedLauncherPath: launcherPath },
        ));
        const refused = runPowerShellInput(
          buildWindowsTaskRestoreScript(taskName),
          {
            expectedLauncherPath: launcherPath,
            taskXmlBase64: before.taskXmlBase64,
            taskSecurityDescriptorBase64: before.taskSecurityDescriptorBase64,
          },
        );
        expect(refused.status !== 0 || refused.error).toBe(true);
        expect(refused.stdout).not.toBe('restored');

        const after = parseTaskSnapshot(runPowerShellInput(
          buildWindowsTaskSnapshotScript(taskName),
          { expectedLauncherPath: launcherPath },
        ));
        expect(after).toEqual(before);
      } catch (error) {
        testFailure = error;
      } finally {
        const cleanup = runPowerShell(CLEANUP_SCRIPT, taskName);
        if (cleanup.status !== 0 || cleanup.error) {
          cleanupFailure = commandFailure('existing restore task cleanup', cleanup);
        }
        rmSync(scratch, { recursive: true, force: true });
      }
      if (testFailure) throw testFailure;
      if (cleanupFailure) throw cleanupFailure;
    }, POWERSHELL_TIMEOUT_MS * 4);

    it('rejects an untrusted write-capable task DACL before the launcher runs', () => {
      const taskName = `${TASK_PREFIX}${process.pid}-${randomUUID()}`;
      const scratch = mkdtempSync(join(tmpdir(), 'ashlr-m93-task-dacl-'));
      const launcherPath = join(scratch, 'ashlr-daemon.cmd');
      const sentinelPath = join(scratch, 'started.txt');
      let testFailure: unknown;
      let cleanupFailure: Error | undefined;
      writeFileSync(
        launcherPath,
        `@echo off\r\n> "${sentinelPath}" echo started\r\n`,
        { mode: 0o600 },
      );

      try {
        createDisposableTask(taskName, launcherPath);
        const mutated = runPowerShell(ADD_UNTRUSTED_WRITE_ACE_SCRIPT, taskName);
        if (mutated.status !== 0 || mutated.error) {
          throw commandFailure('untrusted task DACL mutation', mutated);
        }
        expect(mutated.stdout).toBe('mutated');

        const activated = runPowerShellInput(
          buildWindowsTaskRunScript(taskName),
          { expectedLauncherPath: launcherPath },
        );
        expect(activated.status !== 0 || activated.error).toBe(true);
        expect(activated.stdout).not.toBe('started');
        expect(activated.stderr).toMatch(
          /untrusted identity can modify the task|task DACL is null, empty, or inheritable/,
        );
        sleep(500);
        expect(existsSync(sentinelPath)).toBe(false);
      } catch (error) {
        testFailure = error;
      } finally {
        const cleanup = runPowerShell(CLEANUP_SCRIPT, taskName);
        if (cleanup.status !== 0 || cleanup.error) {
          cleanupFailure = commandFailure('untrusted DACL task cleanup', cleanup);
        }
        rmSync(scratch, { recursive: true, force: true });
      }
      if (testFailure) throw testFailure;
      if (cleanupFailure) throw cleanupFailure;
    }, POWERSHELL_TIMEOUT_MS * 3);

    it('rejects unexpected action arguments before the disposable launcher runs', () => {
      const taskName = `${TASK_PREFIX}${process.pid}-${randomUUID()}`;
      const scratch = mkdtempSync(join(tmpdir(), 'ashlr-m93-task-reject-'));
      const launcherPath = join(scratch, 'ashlr-daemon.cmd');
      const sentinelPath = join(scratch, 'started.txt');
      let testFailure: unknown;
      let cleanupFailure: Error | undefined;
      writeFileSync(
        launcherPath,
        `@echo off\r\n> "${sentinelPath}" echo started\r\n`,
        { mode: 0o600 },
      );

      try {
        const created = runPowerShellInput(CREATE_ARGUMENT_TASK_SCRIPT, {
          taskName,
          launcherPath,
        });
        if (created.status !== 0 || created.error) {
          throw commandFailure('invalid disposable task creation', created);
        }
        const activated = runPowerShellInput(
          buildWindowsTaskRunScript(taskName),
          { expectedLauncherPath: launcherPath },
        );
        expect(activated.status).not.toBe(0);
        expect(activated.stderr).toContain('task action arguments are not supported');
        expect(existsSync(sentinelPath)).toBe(false);
      } catch (error) {
        testFailure = error;
      } finally {
        const cleanup = runPowerShell(CLEANUP_SCRIPT, taskName);
        if (cleanup.status !== 0 || cleanup.error) {
          cleanupFailure = commandFailure('Task Scheduler rejection cleanup', cleanup);
        }
        rmSync(scratch, { recursive: true, force: true });
      }
      if (testFailure) throw testFailure;
      if (cleanupFailure) throw cleanupFailure;
    }, POWERSHELL_TIMEOUT_MS * 2);
  },
);
