import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentDiagnosticsDir,
  agentDiagnosticRunRef,
  classifyAgentDiagnosticError,
  hardenAgentDiagnosticsStore,
  measureAgentDiagnosticText,
  recordAgentDiagnostic,
} from '../src/core/run/agent-diagnostics.js';

function currentLockOwner(): string {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' });
  const startRef = createHash('sha256').update(result.stdout.trim()).digest('hex');
  return `${JSON.stringify({ pid: process.pid, startRef })}\n`;
}

describe('M361 metadata-only agent diagnostics', () => {
  let root: string;
  let previousAshlrHome: string | undefined;

  beforeEach(() => {
    previousAshlrHome = process.env.ASHLR_HOME;
    root = mkdtempSync(join(tmpdir(), 'ashlr-m361-'));
    process.env.ASHLR_HOME = root;
  });

  afterEach(() => {
    if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = previousAshlrHome;
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('persists only private fixed-schema metadata and leaves legacy contents untouched', () => {
    const dir = agentDiagnosticsDir();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const legacyPath = join(dir, 'attempt-legacy.log');
    const legacy = 'raw legacy output must remain operator-owned\n';
    writeFileSync(legacyPath, legacy, { mode: 0o644 });

    const rawOutput = 'RAW_STDOUT=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\ndiff --git a/secret b/secret';
    const rawError = 'Unauthorized token=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const input = {
      runId: 'attempt-018f6d2e-7c50-4f15-8a2c-6efc97fb87a1',
      engine: 'codex' as const,
      ok: false,
      terminationReason: 'backstop-timeout' as const,
      errorClass: classifyAgentDiagnosticError(rawError),
      durationMs: 1234,
      attempt: 2,
      maxAttempts: 3,
      configRecoveryAttempts: 1,
      tokensIn: 42,
      tokensOut: 7,
      output: measureAgentDiagnosticText(rawOutput),
      error: measureAgentDiagnosticText(rawError),
      prompt: 'RAW_PROMPT must never persist',
      argv: ['codex', '--secret', 'value'],
      stdout: rawOutput,
      stderr: rawError,
      worktreePath: '/private/worktree',
      diff: 'diff --git a/secret b/secret',
      env: { SECRET: 'value' },
    };

    expect(recordAgentDiagnostic(input)).toBe(true);

    const runRef = agentDiagnosticRunRef(input.runId)!;
    const path = join(dir, `${runRef}.jsonl`);
    const raw = readFileSync(path, 'utf8');
    const row = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(row).toEqual({
      schemaVersion: 1,
      ts: expect.any(String),
      runRef,
      engine: 'codex',
      ok: false,
      terminationReason: 'backstop-timeout',
      errorClass: 'authentication',
      durationMs: 1234,
      attempt: 2,
      maxAttempts: 3,
      configRecoveryAttempts: 1,
      tokensIn: 42,
      tokensOut: 7,
      output: measureAgentDiagnosticText(rawOutput),
      error: measureAgentDiagnosticText(rawError),
    });
    for (const forbidden of [
      'RAW_PROMPT', 'RAW_STDOUT', 'diff --git', 'ghp_', 'sk-proj-',
      '/private/worktree', '--secret', 'SECRET', input.runId, rawOutput, rawError,
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacy);
    expect(lstatSync(legacyPath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('appends replayable rows for repeated invocations of the same run', () => {
    const input = {
      runId: 'attempt-retry-safe',
      engine: 'claude' as const,
      ok: false,
      errorClass: 'execution' as const,
      durationMs: 10,
      attempt: 1,
      maxAttempts: 2,
      output: measureAgentDiagnosticText('first raw output'),
      error: measureAgentDiagnosticText('first raw error'),
    };
    expect(recordAgentDiagnostic(input)).toBe(true);
    expect(recordAgentDiagnostic({ ...input, ok: true, errorClass: 'none', attempt: 2 })).toBe(true);

    const rows = readFileSync(join(agentDiagnosticsDir(), `${agentDiagnosticRunRef(input.runId)!}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row['attempt'])).toEqual([1, 2]);
    expect(rows.map((row) => row['ok'])).toEqual([false, true]);
  });

  it.skipIf(process.platform === 'win32')('serializes concurrent writers without dropping diagnostics', async () => {
    const writers = 16;
    const source = `
      import { measureAgentDiagnosticText, recordAgentDiagnostic } from './src/core/run/agent-diagnostics.ts';
      const index = Number(process.argv[1]);
      const ok = recordAgentDiagnostic({
        runId: 'attempt-concurrent-' + index,
        engine: 'codex', ok: true, errorClass: 'none', durationMs: 1,
        attempt: 1, maxAttempts: 1,
        output: measureAgentDiagnosticText(''), error: measureAgentDiagnosticText(''),
      });
      if (!ok) process.exitCode = 2;
    `;
    const results = await Promise.all(Array.from({ length: writers }, (_, index) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, String(index)], {
        cwd: process.cwd(),
        env: { ...process.env, ASHLR_HOME: root },
        stdio: 'ignore',
      });
      child.on('error', () => resolve(-1));
      child.on('exit', (code) => resolve(code ?? -1));
    })));

    expect(results).toEqual(Array(writers).fill(0));
    const files = readdirSync(agentDiagnosticsDir()).filter((name) => name.endsWith('.jsonl'));
    expect(files).toHaveLength(writers);
    const rows = files.flatMap((name) => readFileSync(join(agentDiagnosticsDir(), name), 'utf8').trim().split('\n'));
    expect(rows).toHaveLength(writers);
  }, 20_000);

  it.skipIf(process.platform === 'win32')('hashes caller-controlled execution identity before filename or payload persistence', () => {
    const runId = 'RAW_PROMPT_PATH_STDOUT_ERROR_CANARY';
    const runRef = agentDiagnosticRunRef(runId)!;
    expect(runRef).toMatch(/^[a-f0-9]{64}$/);
    expect(runRef).not.toContain(runId);

    expect(recordAgentDiagnostic({
      runId,
      engine: 'codex',
      ok: true,
      errorClass: 'none',
      durationMs: 1,
      attempt: 1,
      maxAttempts: 1,
      output: measureAgentDiagnosticText(''),
      error: measureAgentDiagnosticText(''),
    })).toBe(true);

    const path = join(agentDiagnosticsDir(), `${runRef}.jsonl`);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(runId);
    expect(raw).toContain(`"runRef":"${runRef}"`);
  });

  it.skipIf(process.platform === 'win32')('refuses symlinked directories and files', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ashlr-m361-outside-'));
    try {
      symlinkSync(outside, agentDiagnosticsDir(), 'dir');
      expect(recordAgentDiagnostic({
        runId: 'attempt-symlink-dir',
        engine: 'codex',
        ok: false,
        errorClass: 'execution',
        durationMs: 1,
        attempt: 1,
        maxAttempts: 1,
        output: measureAgentDiagnosticText(''),
        error: measureAgentDiagnosticText('error'),
      })).toBe(false);
      expect(lstatSync(outside).isDirectory()).toBe(true);

      rmSync(agentDiagnosticsDir(), { force: true });
      mkdirSync(agentDiagnosticsDir(), { recursive: true, mode: 0o700 });
      const target = join(outside, 'target');
      writeFileSync(target, 'unchanged', 'utf8');
      const runRef = agentDiagnosticRunRef('attempt-symlink-file')!;
      symlinkSync(target, join(agentDiagnosticsDir(), `${runRef}.jsonl`));
      expect(recordAgentDiagnostic({
        runId: 'attempt-symlink-file',
        engine: 'codex',
        ok: false,
        errorClass: 'execution',
        durationMs: 1,
        attempt: 1,
        maxAttempts: 1,
        output: measureAgentDiagnosticText(''),
        error: measureAgentDiagnosticText('error'),
      })).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('unchanged');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses unsafe identities, malformed metadata, and unbounded file growth', () => {
    const base = {
      runId: 'attempt-bounded',
      engine: 'codex' as const,
      ok: false,
      errorClass: 'execution' as const,
      durationMs: 1,
      attempt: 1,
      maxAttempts: 1,
      output: measureAgentDiagnosticText(''),
      error: measureAgentDiagnosticText('error'),
    };
    expect(recordAgentDiagnostic({ ...base, runId: '../escape' })).toBe(false);
    expect(recordAgentDiagnostic({ ...base, attempt: 2 })).toBe(false);

    mkdirSync(agentDiagnosticsDir(), { recursive: true, mode: 0o700 });
    const path = join(agentDiagnosticsDir(), `${agentDiagnosticRunRef(base.runId)!}.jsonl`);
    writeFileSync(path, 'x'.repeat(64 * 1024), { mode: 0o600 });
    const before = readFileSync(path, 'utf8');
    expect(recordAgentDiagnostic(base)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it.skipIf(process.platform === 'win32')('hardens legacy permissions and expires only metadata records', () => {
    const dir = agentDiagnosticsDir();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const legacyPath = join(dir, 'legacy.log');
    const expiredPath = join(dir, 'attempt-expired.jsonl');
    writeFileSync(legacyPath, 'legacy raw bytes stay unchanged\n', { mode: 0o644 });
    writeFileSync(expiredPath, '{}\n', { mode: 0o644 });
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    utimesSync(expiredPath, old, old);

    const status = hardenAgentDiagnosticsStore();

    expect(status).toMatchObject({
      hardened: true,
      legacyFiles: 1,
      metadataFiles: 0,
      removedMetadataFiles: 1,
      unsafeEntries: 0,
      limitExceeded: false,
    });
    expect(readFileSync(legacyPath, 'utf8')).toBe('legacy raw bytes stay unchanged\n');
    expect(lstatSync(legacyPath).mode & 0o777).toBe(0o600);
    expect(() => lstatSync(expiredPath)).toThrow();
  });

  it.skipIf(process.platform === 'win32')('reclaims malformed per-run crash locks without exempting metadata from retention', () => {
    const dir = agentDiagnosticsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const runRef = agentDiagnosticRunRef('attempt-orphan-retention')!;
    const metadataPath = join(dir, `${runRef}.jsonl`);
    const lockPath = `${metadataPath}.lock`;
    writeFileSync(metadataPath, '{}\n', { mode: 0o600 });
    writeFileSync(lockPath, '', { mode: 0o600 });
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    utimesSync(metadataPath, old, old);

    expect(hardenAgentDiagnosticsStore()).toMatchObject({ removedMetadataFiles: 0 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_050);
    expect(hardenAgentDiagnosticsStore()).toMatchObject({ removedMetadataFiles: 1 });
    expect(() => lstatSync(metadataPath)).toThrow();
    expect(() => lstatSync(lockPath)).toThrow();
  });

  it.skipIf(process.platform === 'win32')('serializes a run with an exclusive append lock', () => {
    const dir = agentDiagnosticsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const runId = 'attempt-locked';
    const runRef = agentDiagnosticRunRef(runId)!;
    const lockPath = join(dir, `${runRef}.jsonl.lock`);
    writeFileSync(lockPath, currentLockOwner(), { mode: 0o600 });
    const input = {
      runId,
      engine: 'codex' as const,
      ok: false,
      errorClass: 'execution' as const,
      durationMs: 1,
      attempt: 1,
      maxAttempts: 1,
      output: measureAgentDiagnosticText(''),
      error: measureAgentDiagnosticText('error'),
    };

    expect(recordAgentDiagnostic(input)).toBe(false);
    expect(() => readFileSync(join(dir, `${runRef}.jsonl`), 'utf8')).toThrow();
    expect(lstatSync(lockPath).isFile()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('recovers append, maintenance, and per-run locks after owner crashes', () => {
    const dir = agentDiagnosticsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const deadOwner = `${JSON.stringify({ pid: 2_147_483_647, startRef: '0'.repeat(64) })}\n`;
    const base = {
      engine: 'codex' as const,
      ok: true,
      errorClass: 'none' as const,
      durationMs: 1,
      attempt: 1,
      maxAttempts: 1,
      output: measureAgentDiagnosticText(''),
      error: measureAgentDiagnosticText(''),
    };

    writeFileSync(join(dir, '.append.lock'), deadOwner, { mode: 0o600 });
    expect(recordAgentDiagnostic({ ...base, runId: 'attempt-orphan-append' })).toBe(true);

    writeFileSync(join(dir, '.maintenance.lock'), deadOwner, { mode: 0o600 });
    expect(recordAgentDiagnostic({ ...base, runId: 'attempt-orphan-maintenance' })).toBe(true);

    const runId = 'attempt-orphan-run';
    const runRef = agentDiagnosticRunRef(runId)!;
    writeFileSync(join(dir, `${runRef}.jsonl.lock`), deadOwner, { mode: 0o600 });
    expect(recordAgentDiagnostic({ ...base, runId })).toBe(true);

    const malformedPath = join(dir, '.append.lock');
    writeFileSync(malformedPath, '', { mode: 0o600 });
    const initialized = new Date(Date.now() - 2_000);
    utimesSync(malformedPath, initialized, initialized);
    expect(recordAgentDiagnostic({ ...base, runId: 'attempt-orphan-uninitialized' })).toBe(true);

    const reusedPidPath = join(dir, '.append.lock');
    writeFileSync(reusedPidPath, `${JSON.stringify({ pid: process.pid, startRef: '0'.repeat(64) })}\n`, { mode: 0o600 });
    utimesSync(reusedPidPath, initialized, initialized);
    expect(recordAgentDiagnostic({ ...base, runId: 'attempt-orphan-reused-pid' })).toBe(true);

    const futurePath = join(dir, '.append.lock');
    writeFileSync(futurePath, '', { mode: 0o600 });
    const future = new Date(Date.now() + 60_000);
    utimesSync(futurePath, future, future);
    expect(recordAgentDiagnostic({ ...base, runId: 'attempt-orphan-future-lock' })).toBe(true);
  });

  it('classifies raw errors into fixed labels without echoing their contents', () => {
    expect(classifyAgentDiagnosticError('429 too many requests SECRET')).toBe('rate-limit');
    expect(classifyAgentDiagnosticError('Unauthorized token SECRET')).toBe('authentication');
    expect(classifyAgentDiagnosticError('ENOENT codex SECRET')).toBe('command-missing');
    expect(classifyAgentDiagnosticError('error loading config SECRET')).toBe('configuration');
    expect(classifyAgentDiagnosticError('spawn ETIMEDOUT SECRET')).toBe('timeout');
    expect(classifyAgentDiagnosticError('killed by signal SIGTERM SECRET')).toBe('terminated');
    expect(classifyAgentDiagnosticError('opaque failure SECRET')).toBe('execution');
    expect(classifyAgentDiagnosticError(undefined)).toBe('none');
  });
});
