import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { buildSandboxLauncher, escapeSbplPath } from '../sandbox/confine.js';
import { runVerifySubprocessAsync, type VerifySubprocessResult } from '../run/verify-commands.js';
import { artifactDigest, digest } from './artifacts.js';
import { assertComparatorUnchanged, type ManifestRecord } from './store.js';

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
  requireProcessGroupExit = false): Promise<VerifySubprocessResult> {
  assertComparatorUnchanged(record);
  if (artifactDigest(artifactPath) !== expectedArtifactDigest) throw new Error('Scored artifact changed before evaluation');
  const evaluator = record.evaluationCommand;
  if (digest(readFileSync(evaluator[0]!)) !== record.evaluationExecutableDigest) throw new Error('Evaluator executable changed');
  const result = await runVerifySubprocessAsync(
    confinedUniverseArgv(evaluator, scratch, scratch, [record.seedArtifact.path, artifactPath], root), {
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
