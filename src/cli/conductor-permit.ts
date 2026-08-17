import { isAbsolute, resolve } from 'node:path';

import {
  buildGoalConductorPermitRequest,
  inspectGoalConductorPermit,
  mintGoalConductorPermitOffline,
  readGoalConductorOperatorEnvelope,
  stageGoalConductorPermit,
  writeGoalConductorOperatorArtifact,
} from '../core/daemon/goal-conductor-permit-operator.js';

const USAGE = `Usage:
  ashlr conductor-permit request --goal <id> --release <sha> --out <absolute-path>
  ashlr conductor-permit mint --request <absolute-path> --key <absolute-pkcs8-der-path> --out <absolute-path>
  ashlr conductor-permit inspect --permit <absolute-path>
  ashlr conductor-permit stage --permit <absolute-path>

The operator is fail-closed and one-shot. request recomputes live bindings and
writes one new 0600 transfer artifact outside Ashlr, repository, worktree,
runtime, and project trees; inspect is read-only. mint is offline-only and
requires request, key, and output in separate exact-private custody directories.
stage recoverably publishes one immutable 0600 permit but does not execute it;
run only the exact command it prints after a separate action-time decision.`;

function option(args: readonly string[], name: string): string | null {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) return null;
  const value = args[indexes[0]! + 1];
  return value && !value.startsWith('-') ? value : null;
}

function exactOptions(args: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith('--') || !allowedSet.has(value)) return false;
    index += 1;
    if (index >= args.length || args[index]!.startsWith('--')) return false;
  }
  return true;
}

function absoluteCanonical(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

function print(result: {
  ok: boolean;
  state: string;
  reason: string;
  permitId?: string;
  command?: readonly string[];
}): void {
  console.log(JSON.stringify({
    schemaVersion: 1,
    ok: result.ok,
    state: result.state,
    reason: result.reason,
    ...(result.permitId ? { permitId: result.permitId } : {}),
    ...(result.command ? { nextCommand: [...result.command] } : {}),
  }, null, 2));
}

async function strictConfig() {
  const { loadConfigReadOnlyStrict } = await import('../core/config.js');
  return loadConfigReadOnlyStrict();
}

export async function cmdConductorPermit(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const [subcommand, ...rest] = args;
  try {
    if (subcommand === 'request') {
      if (!exactOptions(rest, ['--goal', '--release', '--out'])) throw new Error('invalid request arguments');
      const goalId = option(rest, '--goal');
      const release = option(rest, '--release');
      const out = option(rest, '--out');
      if (!goalId || !release || !out) throw new Error('missing request argument');
      if (!absoluteCanonical(out)) throw new Error('request output path must be absolute canonical');
      const result = buildGoalConductorPermitRequest(await strictConfig(), {
        goalId,
        expectedReleaseRevision: release,
        outputPath: out,
      });
      if (result.ok && result.value) writeGoalConductorOperatorArtifact(out, result.value);
      print(result);
      return result.ok ? 0 : 1;
    }
    if (subcommand === 'mint') {
      if (!exactOptions(rest, ['--request', '--key', '--out'])) throw new Error('invalid mint arguments');
      const requestPath = option(rest, '--request');
      const privateKeyPath = option(rest, '--key');
      const out = option(rest, '--out');
      if (!requestPath || !privateKeyPath || !out) throw new Error('missing mint argument');
      if (![requestPath, privateKeyPath, out].every(absoluteCanonical)) {
        throw new Error('mint paths must be absolute canonical');
      }
      const result = mintGoalConductorPermitOffline({
        requestPath,
        privateKeyPath,
        outputPath: out,
      });
      if (result.ok && result.value) writeGoalConductorOperatorArtifact(out, result.value);
      print(result);
      return result.ok ? 0 : 1;
    }
    if (subcommand === 'inspect' || subcommand === 'stage') {
      if (!exactOptions(rest, ['--permit'])) throw new Error(`invalid ${subcommand} arguments`);
      const permitPath = option(rest, '--permit');
      if (!permitPath) throw new Error('missing permit argument');
      if (!absoluteCanonical(permitPath)) throw new Error('permit path must be absolute canonical');
      const envelope = readGoalConductorOperatorEnvelope(permitPath);
      const cfg = await strictConfig();
      const result = subcommand === 'inspect'
        ? inspectGoalConductorPermit(cfg, envelope)
        : stageGoalConductorPermit(cfg, envelope);
      print(result);
      return result.ok ? 0 : 1;
    }
    throw new Error('unknown conductor-permit subcommand');
  } catch {
    console.error('conductor-permit refused: invalid, unsafe, or unavailable input');
    return 2;
  }
}
