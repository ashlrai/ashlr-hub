/** Exact-tree maintainer verification. No producer identity, signing or GitHub writes. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AshlrConfig } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { openStandingVerificationConfinement } from '../inbox/merge.js';
import { detectRepoExecutionProfile } from '../run/repo-profile.js';
import { buildRequiredVerificationManifest } from '../run/verification-manifest.js';
import { detectVerifyCommands, runVerifyCommandAsync, type VerifyCommand } from '../run/verify-commands.js';
import { withRepoLease, withVerificationSlot } from '../sandbox/execution-leases.js';
import { mirrorLeaseKey } from './mirrors.js';
import type { MaintainerPrPins, MaintainerRunEvidence } from './maintainer-pr-verification.js';
import { runSafeGitSync, verifyGitTarget, type SafeGitTarget } from '../sandbox/safe-git.js';
import { MaintainerCargoSettlementError, needsMaintainerCargo, prepareMaintainerCargoDependencies, type MaintainerCargoAttachment } from './maintainer-cargo-dependencies.js';

const OID = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface MaintainerRunPins extends MaintainerPrPins {
  mirrorPath: string;
}
export interface MaintainerRunContext extends MaintainerRunPins {
  cfg: AshlrConfig;
  /** Host rechecks current authority/source; a worker cannot supply this callback through CLI input. */
  assertAuthorized: () => void | Promise<void>;
  signal?: AbortSignal;
}
export interface MaintainerRunInput extends MaintainerRunContext {
  diffSha256: string;
  contractSha256: string;
  expectedCommands: readonly VerifyCommand[];
}
interface RunnerDependencies {
  openConfinement: typeof openStandingVerificationConfinement;
  runCommand: typeof runVerifyCommandAsync;
  lease: <T>(repo: string, fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  slot: <T>(repo: string, fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  prepareCargo: typeof prepareMaintainerCargoDependencies;
}
const defaults: RunnerDependencies = {
  openConfinement: openStandingVerificationConfinement,
  runCommand: runVerifyCommandAsync,
  prepareCargo: prepareMaintainerCargoDependencies,
  lease: async (repo, fn, signal) => {
    const result = await withRepoLease(mirrorLeaseKey(repo), fn, { signal });
    if (!result.ok) throw new Error(`repository lease unavailable: ${result.reason}`);
    return result.value;
  },
  slot: (repo, fn, signal) => withVerificationSlot(mirrorLeaseKey(repo), fn, { signal }),
};

// A linked target is recorded immediately after host creation, before any candidate code runs.
// Later calls compare its .git pointer/back-link to this expected identity rather than trusting
// a pointer rediscovered from an agent-touched worktree.
const scratchTargets = new Map<string, SafeGitTarget>();
function trustedTarget(repo: string): SafeGitTarget {
  if (realpathSync(repo) !== resolve(repo)) throw new Error('Git worktree path must be canonical');
  const recorded = scratchTargets.get(repo);
  if (recorded) return recorded;
  if (!lstatSync(join(repo, '.git')).isDirectory()) throw new Error('unrecorded linked Git worktree');
  return { workTree: repo, gitDir: join(repo, '.git'), layout: 'repo' };
}
function recordScratchTarget(mirror: string, worktree: string): void {
  const pointer = readFileSync(join(worktree, '.git'), 'utf8');
  const match = /^gitdir: (.+)\n?$/.exec(pointer);
  if (!match) throw new Error('new scratch worktree has no Git pointer');
  const gitDir = realpathSync(resolve(worktree, match[1]!));
  const rel = relative(join(mirror, '.git', 'worktrees'), gitDir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('scratch Git directory is outside the trusted mirror');
  const target: SafeGitTarget = { workTree: worktree, gitDir, layout: 'linked' };
  const verified = verifyGitTarget(target);
  if (!verified.ok || verified.commonDir !== join(mirror, '.git')) throw new Error('scratch Git binding does not belong to the mirror');
  scratchTargets.set(worktree, target);
}
function git(repo: string, args: readonly string[]): string {
  const result = runSafeGitSync({ ...trustedTarget(repo), args, timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024, noOptionalLocks: true });
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${scrubSecrets(result.stderr || String(result.code))}`);
  return result.stdout;
}
function removeScratchWorktree(mirror: string, worktree: string): void {
  const registered = () => git(mirror, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${worktree}`);
  if (registered()) git(mirror, ['worktree', 'remove', '--force', worktree]);
  if (registered()) throw new Error('scratch worktree is still registered');
  scratchTargets.delete(worktree);
}
function validatePins(input: MaintainerRunPins): void {
  if (![input.baseSha, input.headSha, input.treeSha].every((oid) => OID.test(oid))) throw new Error('invalid Git pin');
  if (git(input.mirrorPath, ['rev-parse', '--verify', `${input.baseSha}^{commit}`]).trim() !== input.baseSha ||
      git(input.mirrorPath, ['rev-parse', '--verify', `${input.headSha}^{commit}`]).trim() !== input.headSha ||
      git(input.mirrorPath, ['rev-parse', `${input.headSha}^{tree}`]).trim() !== input.treeSha) throw new Error('Git pins do not match actual objects');
}
export function readMaintainerGitBinding(input: MaintainerRunPins): { mergeBaseSha: string; diffSha256: string } {
  validatePins(input);
  const mergeBaseSha = git(input.mirrorPath, ['merge-base', input.baseSha, input.headSha]).trim();
  if (!OID.test(mergeBaseSha)) throw new Error('ambiguous or missing merge base');
  return {
    mergeBaseSha,
    // Fixed Git diff options; external diff/textconv never execute candidate code.
    diffSha256: hash(git(input.mirrorPath, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', input.baseSha, input.headSha, '--'])),
  };
}
function commandIdentity(command: VerifyCommand): unknown {
  return { id: command.id ?? null, kind: command.kind, cmd: [...command.cmd], cwd: command.cwd ?? '.',
    timeoutMs: command.timeoutMs ?? null, required: command.required !== false, profiles: command.profiles ?? null };
}
function freezeCommands(commands: readonly VerifyCommand[]): readonly VerifyCommand[] {
  return Object.freeze(commands.map((command) => Object.freeze({ ...command,
    cmd: Object.freeze([...command.cmd]) as unknown as string[],
    ...(command.profiles ? { profiles: Object.freeze([...command.profiles]) as unknown as VerifyCommand['profiles'] } : {}),
  })));
}
/**
 * v1 digest binds the entire immutable base tree (including all contract/manifest files),
 * the detector's canonical source metadata and the required merge command sequence.
 * Absolute scratch paths never enter the digest. Reject invalid or unreadable contracts.
 */
export function calculateMaintainerVerificationContract(baseWorktree: string): { contractSha256: string; commands: readonly VerifyCommand[] } {
  const opts = { trustedGitRead: (args: readonly string[]) => git(baseWorktree, args) };
  const profile = detectRepoExecutionProfile(baseWorktree, opts);
  if (profile.mergeVerifyContractSource.inputState !== 'complete' ||
      (profile.verifyContract?.present && (!profile.verifyContract.valid || profile.verifyContractSource !== 'tracked-clean'))) {
    throw new Error('base verification contract is invalid, unreadable or not tracked-clean');
  }
  if (git(baseWorktree, ['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('base worktree is modified');
  const commands = freezeCommands(detectVerifyCommands(baseWorktree, 'merge', opts).filter((command) => command.required !== false).map((command) => {
    // The detector uses absolute project cwd paths. Bind them relative to the base
    // so a second scratch checkout derives the same digest and runs in HEAD, not BASE.
    const cwd = command.cwd ? relative(baseWorktree, resolve(baseWorktree, command.cwd)) : '';
    if (cwd.startsWith('..') || isAbsolute(cwd)) throw new Error('base command cwd is outside its worktree');
    return { ...command, cwd: cwd || undefined };
  }));
  const manifest = buildRequiredVerificationManifest(resolve(baseWorktree), commands);
  if (!manifest) throw new Error('base has no valid required merge verification commands');
  const contractSha256 = hash(JSON.stringify(['ashlr:maintainer-verification-contract:v1',
    git(baseWorktree, ['rev-parse', 'HEAD^{tree}']).trim(), profile.mergeVerifyContractSource,
    manifest.digest, commands.map(commandIdentity)]));
  return { contractSha256, commands };
}
async function basePlan(input: MaintainerRunContext, deps: RunnerDependencies): Promise<ReturnType<typeof calculateMaintainerVerificationContract>> {
  return deps.lease(input.mirrorPath, async () => {
    await input.assertAuthorized();
    validatePins(input);
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-maintainer-base-')));
    const base = join(scratch, 'base');
    try {
      git(input.mirrorPath, ['worktree', 'add', '--detach', base, input.baseSha]);
      recordScratchTarget(input.mirrorPath, base);
      return calculateMaintainerVerificationContract(base);
    } finally {
      removeScratchWorktree(input.mirrorPath, base);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, input.signal);
}
export async function prepareMaintainerRun(input: MaintainerRunContext, _deps: Partial<RunnerDependencies> = {}): Promise<MaintainerRunInput> {
  const deps = { ...defaults, ..._deps };
  await input.assertAuthorized();
  if (input.signal?.aborted) throw new Error('verification preparation cancelled');
  const binding = readMaintainerGitBinding(input);
  const plan = await basePlan(input, deps);
  if (binding.mergeBaseSha !== input.mergeBaseSha || binding.mergeBaseSha !== input.baseSha) throw new Error('protected base is not the exact merge base');
  return Object.freeze({ ...input, ...binding, contractSha256: plan.contractSha256, expectedCommands: plan.commands });
}
export async function runMaintainerPr(input: MaintainerRunInput, _deps: Partial<RunnerDependencies> = {}): Promise<MaintainerRunEvidence> {
  const deps = { ...defaults, ..._deps };
  input = Object.freeze({ ...input, expectedCommands: freezeCommands(input.expectedCommands) });
  const executed: MaintainerRunEvidence['commands'][number][] = [];
  const result: MaintainerRunEvidence = { ok: false, baseSha: input.baseSha, headSha: input.headSha, treeSha: input.treeSha,
    mergeBaseSha: input.mergeBaseSha, diffSha256: input.diffSha256, contractSha256: input.contractSha256,
    expectedCommands: input.expectedCommands, commands: executed, sourceUnchanged: false, worktreeRemoved: true, confinement: 'required' };
  let scratch: string | null = null;
  let worktree: string | null = null;
  let confined: Awaited<ReturnType<typeof openStandingVerificationConfinement>> = null;
  let cargo: MaintainerCargoAttachment | null = null;
  let resourcesSafe = true;
  try {
    if (![input.diffSha256, input.contractSha256].every((digest) => DIGEST.test(digest)) || !OID.test(input.mergeBaseSha)) throw new Error('invalid verification binding');
    await deps.slot(input.mirrorPath, async () => {
      await input.assertAuthorized();
      const prepared = await prepareMaintainerRun(input, deps);
      if (prepared.mergeBaseSha !== input.mergeBaseSha || prepared.diffSha256 !== input.diffSha256 ||
          prepared.contractSha256 !== input.contractSha256 || JSON.stringify(prepared.expectedCommands.map(commandIdentity)) !== JSON.stringify(input.expectedCommands.map(commandIdentity))) {
        throw new Error('verification inputs changed or commands are not the independently detected base commands');
      }
      scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-maintainer-head-')));
      worktree = join(scratch, 'head');
      await deps.lease(input.mirrorPath, async () => {
        await input.assertAuthorized(); validatePins(input);
        result.worktreeRemoved = false;
        git(input.mirrorPath, ['worktree', 'add', '--detach', worktree!, input.headSha]);
        recordScratchTarget(input.mirrorPath, worktree!);
      }, input.signal);
      if (needsMaintainerCargo(prepared.expectedCommands)) {
        cargo = await deps.prepareCargo({ worktree: worktree!, sourceTree: input.treeSha, signal: input.signal, assertAuthorized: input.assertAuthorized });
        result.cargoDependencies = cargo.receipt;
        result.dependenciesRemoved = false;
        await input.assertAuthorized();
        if (input.signal?.aborted) throw new Error('verification cancelled');
      }
      confined = await deps.openConfinement(worktree!, cargo ? { cargoAttachment: cargo } : {});
      if (!confined) throw new Error('required verification confinement is unavailable');
      for (const command of prepared.expectedCommands) {
        if (input.signal?.aborted) throw new Error('verification cancelled');
        await input.assertAuthorized();
        cargo?.assertCurrent(worktree!);
        const startedAt = new Date().toISOString(); const started = performance.now();
        resourcesSafe = false;
        const commandResult = await deps.runCommand(command, worktree!, input.cfg, { signal: input.signal, _runSubprocess: confined.runSubprocess, requireProcessGroupExit: true });
        resourcesSafe = commandResult.processGroupSettlement === 'not-started' || commandResult.processGroupSettlement === 'group-exit-confirmed';
        if (!resourcesSafe) result.cleanupRetention = { reason: 'process-group-exit-unconfirmed', recovery: 'observe-group-absence-before-owned-cleanup',
          verificationHome: commandResult.retainedVerificationHome, confinementRoot: commandResult.retainedConfinementRoot,
          processGroupId: commandResult.processGroupId };
        executed.push({ command, result: commandResult, startedAt, durationMs: performance.now() - started, outputSha256: hash(commandResult.output) });
        cargo?.assertCurrent(worktree!);
        if (!resourcesSafe) throw new Error('verification process-group exit unconfirmed; owned resources retained for absence inspection');
        if (!commandResult.ok) throw new Error(`required command failed: ${command.id ?? command.kind}`);
      }
      await input.assertAuthorized();
      if (input.signal?.aborted) throw new Error('verification cancelled');
      const after = readMaintainerGitBinding(input);
      if (after.mergeBaseSha !== input.mergeBaseSha || after.diffSha256 !== input.diffSha256 ||
          git(worktree!, ['rev-parse', 'HEAD']).trim() !== input.headSha ||
          git(worktree!, ['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('source changed during verification');
      result.sourceUnchanged = true;
      result.ok = result.commands.length === prepared.expectedCommands.length && result.commands.length > 0;
    }, input.signal);
  } catch (error) {
    if (error instanceof MaintainerCargoSettlementError) {
      resourcesSafe = false;
      result.dependenciesRemoved = false;
      result.cleanupRetention = { reason: 'process-group-exit-unconfirmed', recovery: 'observe-group-absence-before-owned-cleanup',
        dependencyRoot: error.resourceRoot, processGroupId: error.processGroupId };
    }
    result.ok = false; result.reason = scrubSecrets(error instanceof Error ? error.message : String(error));
  } finally {
    if (!resourcesSafe) {
      const retainedConfinement = confined as Awaited<ReturnType<typeof openStandingVerificationConfinement>>;
      result.ok = false;
      result.reason = 'verification process-group exit unconfirmed; inspect recorded group absence before cleaning retained owned resources; no signalling authority is retained';
      result.cleanupRetention = { reason: 'process-group-exit-unconfirmed', recovery: 'observe-group-absence-before-owned-cleanup', ...result.cleanupRetention,
        ...(worktree ? { worktree } : {}), ...(cargo ? { dependencyRoot: (cargo as MaintainerCargoAttachment).resourceRoot } : {}),
        ...(retainedConfinement?.resourceRoot ? { confinementRoot: retainedConfinement.resourceRoot } : {}) };
    } else {
      try { (confined as Awaited<ReturnType<typeof openStandingVerificationConfinement>>)?.close(); }
      catch (error) { result.ok = false; result.reason = `confinement cleanup failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`; }
      try {
        if (cargo) { (cargo as MaintainerCargoAttachment).close(); result.dependenciesRemoved = true; }
      } catch (error) { result.ok = false; result.reason = `dependency cleanup failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`; }
      try {
        if (worktree && !result.worktreeRemoved) await deps.lease(input.mirrorPath, async () => {
          removeScratchWorktree(input.mirrorPath, worktree!); result.worktreeRemoved = true;
        });
        if (worktree) scratchTargets.delete(worktree);
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      } catch (error) {
        result.ok = false; result.reason = `verification cleanup failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`;
      }
    }
  }
  return result;
}
