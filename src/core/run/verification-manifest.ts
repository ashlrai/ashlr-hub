import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { VerifyCommand, VerifyCommandProfile } from './verify-commands.js';

export interface RequiredVerificationManifest {
  digest: string;
  commandCount: number;
}

const PROFILES = new Set<VerifyCommandProfile>(['quick', 'merge', 'deep']);

/** Canonical metadata-only identity for the required commands executed in order. */
export function buildRequiredVerificationManifest(
  repoRoot: string,
  commands: readonly VerifyCommand[],
): RequiredVerificationManifest | null {
  if (!isAbsolute(repoRoot)) return null;
  const root = resolve(repoRoot);
  const required = commands.filter((command) => command.required !== false);
  if (required.length === 0) return null;
  const canonical: unknown[] = [];
  for (const command of required) {
    if (!command || !['typecheck', 'lint', 'build', 'test'].includes(command.kind) ||
      !Array.isArray(command.cmd) || command.cmd.length === 0 ||
      command.cmd.some((arg) => typeof arg !== 'string' || arg.length === 0 || arg.length > 8_192) ||
      (command.id !== undefined && (typeof command.id !== 'string' || command.id.length === 0 || command.id.length > 240)) ||
      (command.cwd !== undefined && (typeof command.cwd !== 'string' || command.cwd.length === 0 || command.cwd.length > 4_096)) ||
      (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0)) ||
      (command.profiles !== undefined && (!Array.isArray(command.profiles) ||
        command.profiles.some((profile) => !PROFILES.has(profile))))) return null;
    const commandCwd = command.cwd === undefined
      ? root
      : resolve(isAbsolute(command.cwd) ? command.cwd : resolve(root, command.cwd));
    const cwd = relative(root, commandCwd).replace(/\\/g, '/') || '.';
    if (cwd === '..' || cwd.startsWith('../') || isAbsolute(cwd)) return null;
    canonical.push({
      id: command.id ?? null,
      kind: command.kind,
      cmd: [...command.cmd],
      cwd,
      timeoutMs: command.timeoutMs ?? null,
      required: true,
      profiles: command.profiles ? [...new Set(command.profiles)].sort() : null,
    });
  }
  return {
    digest: createHash('sha256').update(JSON.stringify([
      'ashlr:required-verification-manifest:v1',
      canonical,
    ])).digest('hex'),
    commandCount: canonical.length,
  };
}
