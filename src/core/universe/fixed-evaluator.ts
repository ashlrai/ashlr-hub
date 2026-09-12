import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildSandboxLauncher, escapeSbplPath } from '../sandbox/confine.js';
import { runVerifySubprocessAsync, type VerifySubprocessResult } from '../run/verify-commands.js';
import { artifactDigest, digest } from './artifacts.js';
import { assertComparatorUnchanged, type ManifestRecord } from './store.js';
import { resolveBuiltinEvaluator } from './builtin-evaluator-registry.js';
import { initializeBuiltinActivity, inspectBuiltinActivity, type BuiltinActivityOwner } from '../../../scripts/evaluators/preparation-verification-activity.mjs';

/** Shared bounded evaluator confinement for ordinary trials and integration candidates. */
export function confinedUniverseArgv(command: string[], writable: string, scratch: string, readable: string[], root: string): string[] {
  if (process.platform !== 'darwin') throw new Error('Universe local execution currently requires macOS sandbox-exec; other platforms have no verified Universe confinement profile');
  const env = { HOME: scratch, TMPDIR: scratch };
  const launcher = buildSandboxLauncher({ mode: 'os', networkEgress: false, onUnsupported: 'fail',
    readAllowed: [...readable, dirname(command[0]!)] }, { worktree: writable, home: homedir(), env });
  if (!launcher) throw new Error('Universe experiments require OS confinement');
  if (process.platform === 'darwin') {
    const subpath = (path: string): string => `(subpath "${escapeSbplPath(resolve(path))}")`;
    const ancestors = new Set<string>();
    for (const path of [writable, scratch, ...readable, command[0]!]) {
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        ancestors.add(parent);
        if (dirname(parent) === parent) break;
      }
    }
    const profile = `${launcher.prefixArgs[1]}\n` +
      `(deny file-read* ${subpath(homedir())} ${subpath(root)})\n` +
      `(allow file-read* ${[writable, scratch, ...readable, dirname(command[0]!)].map(subpath).join(' ')})\n` +
      `(allow file-read-metadata ${[...ancestors].map((path) => `(literal "${escapeSbplPath(path)}")`).join(' ')})\n` +
      `(deny file-write*)\n(allow file-write* ${subpath(writable)} ${subpath(scratch)} (literal "/dev/null"))\n`;
    return ['/usr/bin/sandbox-exec', '-p', profile, ...command];
  }
  throw new Error('Universe experiments require macOS sandbox-exec');
}

/** Runs the already-pinned evaluator without granting any candidate write access. */
export async function runFixedUniverseEvaluator(record: ManifestRecord, root: string, artifactPath: string,
  expectedArtifactDigest: string, scratch: string, timeoutMs: number, signal: AbortSignal, env: NodeJS.ProcessEnv,
  requireProcessGroupExit = false, beforeStart?: () => void): Promise<VerifySubprocessResult> {
  const deadline = performance.now() + timeoutMs;
  assertComparatorUnchanged(record);
  if (artifactDigest(artifactPath) !== expectedArtifactDigest) throw new Error('Scored artifact changed before evaluation');
  if (record.manifest.evaluation.builtin !== undefined) {
    const installed = resolveBuiltinEvaluator(record.manifest.evaluation.builtin);
    if (installed.digest !== record.evaluationBuiltinDigest || JSON.stringify(installed.command) !== JSON.stringify(record.evaluationCommand)) {
      throw new Error('Installed built-in evaluator changed');
    }
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0 || signal.aborted) return { stdout: '', stderr: '', exitCode: -1, signal: null,
      timedOut: remaining <= 0, cancelled: signal.aborted, processGroupSettlement: 'not-started' };
    // Only the closed installed implementation runs outside an evaluator
    // sandbox. Neither seed command bytes nor supplied environment select code.
    const activityRoot = mkdtempSync(join(scratch, 'builtin-activity-'));
    const owner: BuiltinActivityOwner = { schemaVersion: 1, invocationId: randomBytes(32).toString('hex'),
      implementationDigest: installed.digest, deadlineAt: new Date(Date.now() + remaining).toISOString() };
    initializeBuiltinActivity(activityRoot, owner);
    const builtinEnv = { PATH: `${dirname(installed.git.path)}:/usr/bin:/bin:${dirname(process.execPath)}`, HOME: scratch, TMPDIR: scratch,
      USERPROFILE: scratch, ASHLR_HOME: scratch, ASHLR_UNIVERSE_CANDIDATE: artifactPath,
      ASHLR_UNIVERSE_BUILTIN_ACTIVITY: activityRoot, ASHLR_UNIVERSE_BUILTIN_GIT: JSON.stringify(installed.git), LANG: 'C', LC_ALL: 'C' };
    beforeStart?.();
    const dispatchRemaining = Math.floor(deadline - performance.now());
    if (dispatchRemaining <= 0 || signal.aborted) return { stdout: '', stderr: '', exitCode: -1, signal: null,
      timedOut: dispatchRemaining <= 0, cancelled: signal.aborted, processGroupSettlement: 'not-started' };
    const result = await runVerifySubprocessAsync(installed.command, { cwd: scratch, env: builtinEnv,
      timeoutMs: dispatchRemaining, signal, requireProcessGroupExit: true });
    // A controller's group alone says nothing about its separately owned
    // candidate/tool groups. Keep all activity evidence on any uncertainty.
    if (!['not-started', 'group-exit-confirmed'].includes(result.processGroupSettlement ?? '')) return result;
    if (result.processGroupSettlement !== 'not-started' && !inspectBuiltinActivity(activityRoot, owner)) {
      return { ...result, error: 'Built-in evaluator process settlement unconfirmed', processGroupSettlement: 'unconfirmed' };
    }
    assertComparatorUnchanged(record);
    if (artifactDigest(artifactPath) !== expectedArtifactDigest) throw new Error('Scored artifact changed during evaluation');
    return result;
  }
  const evaluator = record.evaluationCommand;
  if (digest(readFileSync(evaluator[0]!)) !== record.evaluationExecutableDigest) throw new Error('Evaluator executable changed');
  const argv = confinedUniverseArgv(evaluator, scratch, scratch, [record.seedArtifact.path, artifactPath], root);
  // Run after potentially expensive integrity/profile preparation. The async
  // subprocess runner reaches its spawn synchronously from this call.
  beforeStart?.();
  const result = await runVerifySubprocessAsync(argv, {
      cwd: record.seedArtifact.path, env, timeoutMs, signal, requireProcessGroupExit,
    });
  // An unresolved process group is more important than integrity reporting: its
  // durable caller must retain its intent rather than record a settled result.
  if (requireProcessGroupExit &&
      !['not-started', 'group-exit-confirmed'].includes(result.processGroupSettlement ?? '')) return result;
  assertComparatorUnchanged(record);
  if (artifactDigest(artifactPath) !== expectedArtifactDigest) throw new Error('Scored artifact changed during evaluation');
  return result;
}
