import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateServiceDefinition,
  parseExactLaunchdPrintRuntime,
  type ServiceInstallOptions,
} from '../src/core/daemon/service.js';

const NATIVE_ENABLED = process.platform === 'darwin'
  && process.env.ASHLR_RUN_NATIVE_LAUNCHD_TEST === '1';
const COMMAND_TIMEOUT_MS = 15_000;
const CLEANUP_MANIFEST = 'ashlr-m93-launchd-cleanup.json';

function launchctl(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('launchctl', args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
}

function absent(result: ReturnType<typeof launchctl>): boolean {
  return result.status !== 0
    && !result.error
    && /(?:could not find (?:specified )?service|service .* not found|no such process)/i
      .test(`${result.stdout}\n${result.stderr}`);
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

describe.skipIf(!NATIVE_ENABLED)('M93 native launchd runtime admission', () => {
  it('accepts an exact disposable job and withholds a stale command contract', () => {
    const runnerTemp = process.env.RUNNER_TEMP;
    if (!runnerTemp) throw new Error('native launchd integration requires RUNNER_TEMP');

    const scratch = mkdtempSync(join(runnerTemp, `ashlr-m93-launchd-${randomUUID()}-`));
    const homeDir = join(scratch, 'home');
    const fixturePath = join(scratch, 'fixture.mjs');
    const label = `ai.ashlr.m93.${randomUUID().replaceAll('-', '')}`;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const domainTarget = `gui/${uid}`;
    const serviceTarget = `${domainTarget}/${label}`;
    const manifestPath = join(runnerTemp, CLEANUP_MANIFEST);
    const opts: ServiceInstallOptions = {
      platform: 'darwin',
      homeDir,
      nodePath: process.execPath,
      binPath: fixturePath,
      budget: 1,
      intervalMs: 60_000,
      parallel: 1,
    };
    const definition = generateServiceDefinition(opts);
    const runtime = definition.launchdRuntime;
    if (!runtime) throw new Error('generated launchd runtime contract is missing');
    const content = definition.content.replaceAll('ai.ashlr.daemon', label);
    let bootstrapAttempted = false;
    let manifestWritten = false;
    let testFailure: unknown;
    let cleanupFailure: Error | undefined;

    try {
      const before = launchctl(['print', serviceTarget]);
      if (!absent(before)) {
        throw new Error(
          `native launchd test refused: ${serviceTarget} was present or unreadable: `
          + `${before.stderr || before.stdout}`,
        );
      }

      mkdirSync(dirname(definition.filePath), { recursive: true, mode: 0o700 });
      mkdirSync(join(homeDir, '.ashlr'), { recursive: true, mode: 0o700 });
      writeFileSync(fixturePath, 'setInterval(() => {}, 1000);\n', { mode: 0o600 });
      writeFileSync(definition.filePath, content, { mode: 0o600 });
      writeFileSync(manifestPath, JSON.stringify({
        schemaVersion: 1,
        label,
        scratch,
        plistPath: definition.filePath,
        program: runtime.program,
        arguments: runtime.arguments,
      }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      manifestWritten = true;

      bootstrapAttempted = true;
      const bootstrapped = launchctl(['bootstrap', domainTarget, definition.filePath]);
      if (bootstrapped.status !== 0 || bootstrapped.error || bootstrapped.stderr.trim() !== '') {
        throw new Error(`launchctl bootstrap failed: ${bootstrapped.stderr || bootstrapped.stdout}`);
      }

      let exactRuntime = parseExactLaunchdPrintRuntime(
        String(launchctl(['print', serviceTarget]).stdout),
        serviceTarget,
        definition.filePath,
        runtime.program,
        runtime.arguments,
      );
      expect(waitUntil(() => {
        const printed = launchctl(['print', serviceTarget]);
        if (printed.status !== 0 || printed.error || printed.stderr.trim() !== '') return false;
        exactRuntime = parseExactLaunchdPrintRuntime(
          String(printed.stdout),
          serviceTarget,
          definition.filePath,
          runtime.program,
          runtime.arguments,
        );
        return exactRuntime?.pid !== undefined;
      })).toBe(true);
      expect(exactRuntime?.pid).toBeGreaterThan(0);
      expect(parseExactLaunchdPrintRuntime(
        String(launchctl(['print', serviceTarget]).stdout),
        serviceTarget,
        definition.filePath,
        runtime.program,
        runtime.arguments.map((argument, index) => index === 1 ? `${argument}.stale` : argument),
      )).toBeNull();
    } catch (error) {
      testFailure = error;
    } finally {
      if (bootstrapAttempted) {
        let after = launchctl(['print', serviceTarget]);
        if (!absent(after)) {
          const owned = after.status === 0 && !after.error && after.stderr.trim() === ''
            ? parseExactLaunchdPrintRuntime(
                String(after.stdout),
                serviceTarget,
                definition.filePath,
                runtime.program,
                runtime.arguments,
              )
            : null;
          if (!owned) {
            cleanupFailure = new Error(
              `native launchd cleanup refused because fixture ownership was not exact `
              + `(preserved ${definition.filePath}): ${after.stderr || after.stdout}`,
            );
          } else {
            launchctl(['bootout', domainTarget, definition.filePath]);
            after = launchctl(['print', serviceTarget]);
            for (let attempt = 0; attempt < 50 && !absent(after); attempt++) {
              sleep(100);
              after = launchctl(['print', serviceTarget]);
            }
          }
        }
        if (!cleanupFailure && !absent(after)) {
          cleanupFailure = new Error(
            `native launchd cleanup could not prove ${serviceTarget} absent `
            + `(preserved ${definition.filePath}): `
            + `${after.stderr || after.stdout}`,
          );
        }
      }
      if (!cleanupFailure) {
        rmSync(scratch, { recursive: true, force: true });
        if (manifestWritten) rmSync(manifestPath, { force: true });
      }
    }

    if (testFailure && cleanupFailure) {
      throw new AggregateError([testFailure, cleanupFailure], 'native launchd test and cleanup failed');
    }
    if (cleanupFailure) throw cleanupFailure;
    if (testFailure) throw testFailure;
  }, 30_000);
});
