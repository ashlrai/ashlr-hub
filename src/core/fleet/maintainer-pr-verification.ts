/**
 * Host-owned verification of an existing maintainer PR. This is deliberately
 * separate from fleet producer provenance and the fleet's single-parent rule.
 * A receipt is created only by this invocation's real runner; saved receipts
 * are evidence, never an input that can authorize a green check.
 */
import { createHash } from 'node:crypto';
import { canonicalizeDaemonActivationValue } from '../daemon/activation-permit.js';
import type { EffectivePolicy } from '../authority/types.js';
import type { VerifyCommand, VerifyCommandResult } from '../run/verify-commands.js';
import { scrubSecrets } from '../util/scrub.js';
import type { HostMergeDeps, GithubReply } from './host-merge.js';
import { ASHLR_VERIFY_CHECK_NAME } from './verify-check-run.js';
import { needsMaintainerCargo, type MaintainerCargoReceipt } from './maintainer-cargo-dependencies.js';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export interface MaintainerPrPins {
  repo: string;
  pr: number;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  treeSha: string;
  /** The current protected base must be an ancestor of the exact head. */
  mergeBaseSha: string;
}

export interface MaintainerCommandEvidence {
  command: VerifyCommand;
  result: VerifyCommandResult;
  startedAt: string;
  durationMs: number;
  outputSha256: string;
}

export interface MaintainerRunEvidence {
  ok: boolean;
  reason?: string;
  baseSha: string;
  headSha: string;
  treeSha: string;
  mergeBaseSha: string;
  diffSha256: string;
  contractSha256: string;
  expectedCommands: readonly VerifyCommand[];
  commands: readonly MaintainerCommandEvidence[];
  confinement: 'required';
  sourceUnchanged: boolean;
  worktreeRemoved: boolean;
  cargoDependencies?: MaintainerCargoReceipt;
  dependenciesRemoved?: boolean;
}

export interface MaintainerVerificationReceipt {
  v: 2;
  kind: 'maintainer-pr-verification';
  actor: string;
  source: MaintainerPrPins;
  authority: { grantId: string; grantSeq: number; policySha256: string; killEpoch: string; rulesSha256: string; appId: number };
  startedAt: string;
  finishedAt: string;
  run: MaintainerRunEvidence;
  receiptSha256: string;
}

export interface MaintainerVerificationDeps extends Pick<HostMergeDeps, 'transport' | 'token' | 'nowMs' | 'policy' | 'killActive' | 'killEpoch'> {
  /** Host's authenticated GitHub login, not a user-supplied actor label. */
  authenticatedActor(): Promise<string>;
  run(pins: MaintainerPrPins): Promise<MaintainerRunEvidence>;
  /** Serialize the final policy/source recheck and outward call with Stop. */
  fenced<T>(fn: () => Promise<T>): Promise<T>;
  publicationFenceHeld(): boolean;
  record(receipt: MaintainerVerificationReceipt): void;
}

export type MaintainerVerificationResult =
  | { ok: true; receipt: MaintainerVerificationReceipt; check: { id: number; appId: number; headSha: string }; action: 'created' | 'unchanged' }
  | { ok: false; reason: string; receipt?: MaintainerVerificationReceipt };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function maintainerEvidenceDigest(value: unknown): string {
  return createHash('sha256').update(canonicalizeDaemonActivationValue(value)).digest('hex');
}

function policyDigest(policy: EffectivePolicy): string {
  const { computedAt: _computedAt, ...binding } = policy;
  return maintainerEvidenceDigest(binding);
}

function requirePolicy(repo: string, deps: MaintainerVerificationDeps): EffectivePolicy {
  if (deps.killActive()) throw new Error('Stop is active or unavailable');
  const policy = deps.policy();
  if (!policy || Date.parse(policy.expiresAt) <= deps.nowMs() || !Number.isFinite(Date.parse(policy.expiresAt)) ||
      !policy.repos.some((entry) => entry.nameWithOwner.toLowerCase() === repo.toLowerCase())) {
    throw new Error('no current signed authority for this repository');
  }
  return policy;
}

async function request(deps: MaintainerVerificationDeps, repo: string, suffix: string, body?: unknown, beforeDispatch?: () => void): Promise<GithubReply> {
  const token = (await deps.token(repo)).token;
  beforeDispatch?.();
  return deps.transport({ method: body === undefined ? 'GET' : 'POST', path: `/repos/${repo}${suffix}`, token, ...(body === undefined ? {} : { body }) });
}

async function read(deps: MaintainerVerificationDeps, repo: string, suffix: string): Promise<unknown> {
  const reply = await request(deps, repo, suffix);
  if (reply.status !== 200) throw new Error(`GitHub read failed (${reply.status}) for ${suffix.split('?')[0]}`);
  return reply.body;
}

interface Observation { source: MaintainerPrPins; rulesSha256: string; appId: number }

async function observe(repo: string, pr: number, actor: string, deps: MaintainerVerificationDeps): Promise<Observation> {
  const repoBody = object(await read(deps, repo, ''));
  const defaultBranch = repoBody?.['default_branch'];
  if (repoBody?.['full_name'] !== repo || typeof defaultBranch !== 'string' || !defaultBranch || defaultBranch.length > 200) {
    throw new Error('repository identity or protected base is unavailable');
  }
  const permission = object(await read(deps, repo, `/collaborators/${encodeURIComponent(actor)}/permission`));
  if (object(permission?.['user'])?.['login'] !== actor || !['admin', 'maintain', 'write'].includes(String(permission?.['permission']))) {
    throw new Error('authenticated GitHub account is not a repository maintainer');
  }
  const pull = object(await read(deps, repo, `/pulls/${pr}`));
  const base = object(pull?.['base']);
  const head = object(pull?.['head']);
  if (pull?.['number'] !== pr || pull?.['state'] !== 'open' || base?.['ref'] !== defaultBranch ||
      object(base?.['repo'])?.['full_name'] !== repo || typeof head?.['sha'] !== 'string' || !SHA.test(head['sha'])) {
    throw new Error('PR is not open against this repository default branch');
  }
  const branch = object(await read(deps, repo, `/branches/${encodeURIComponent(defaultBranch)}`));
  const baseSha = object(branch?.['commit'])?.['sha'];
  if (branch?.['protected'] !== true || typeof baseSha !== 'string' || !SHA.test(baseSha) || base?.['sha'] !== baseSha) {
    throw new Error('current protected base does not match the PR base');
  }
  const headSha = head['sha'];
  const commit = object(await read(deps, repo, `/git/commits/${headSha}`));
  const treeSha = object(commit?.['tree'])?.['sha'];
  if (commit?.['sha'] !== headSha || typeof treeSha !== 'string' || !SHA.test(treeSha)) throw new Error('head commit/tree is unavailable');
  const comparison = object(await read(deps, repo, `/compare/${baseSha}...${headSha}?per_page=1`));
  const mergeBaseSha = object(comparison?.['merge_base_commit'])?.['sha'];
  if (object(comparison?.['base_commit'])?.['sha'] !== baseSha || mergeBaseSha !== baseSha ||
      !['ahead', 'identical'].includes(String(comparison?.['status']))) {
    throw new Error('PR must contain the current protected base before verification');
  }
  const rules = await read(deps, repo, `/rules/branches/${encodeURIComponent(defaultBranch)}`);
  if (!Array.isArray(rules)) throw new Error('active branch rules are unavailable');
  const appIds = rules.flatMap((rule) => {
    const entry = object(rule);
    if (entry?.['type'] !== 'required_status_checks') return [];
    const checks = object(entry['parameters'])?.['required_status_checks'];
    if (!Array.isArray(checks)) throw new Error('required checks are malformed');
    return checks.filter((check) => object(check)?.['context'] === ASHLR_VERIFY_CHECK_NAME)
      .map((check) => object(check)?.['integration_id']);
  });
  const appId = appIds[0];
  if (!Number.isSafeInteger(appId) || Number(appId) <= 0 || appIds.some((id) => id !== appId)) {
    throw new Error('ashlr/verify is not bound to one trusted App in active branch rules');
  }
  return {
    source: { repo, pr, baseBranch: defaultBranch, baseSha, headSha, treeSha, mergeBaseSha },
    rulesSha256: maintainerEvidenceDigest(rules), appId: Number(appId),
  };
}

/** Independently check complete executed-command evidence; a summary `ok` is insufficient. */
export function maintainerRunFailure(pins: MaintainerPrPins, run: MaintainerRunEvidence): string | null {
  if (!run.ok || run.confinement !== 'required' || !run.sourceUnchanged || !run.worktreeRemoved) return 'verification failed, confinement was unavailable, or cleanup/source checks failed';
  for (const key of ['baseSha', 'headSha', 'treeSha', 'mergeBaseSha'] as const) {
    if (run[key] !== pins[key] || !SHA.test(run[key])) return `verification ${key} does not match the PR`;
  }
  if (!DIGEST.test(run.diffSha256) || !DIGEST.test(run.contractSha256)) return 'diff/contract evidence is missing';
  if (needsMaintainerCargo(run.expectedCommands)) {
    const deps = run.cargoDependencies;
    if (!deps || run.dependenciesRemoved !== true || deps.v !== 1 || deps.recipe !== 'cargo-vendor-locked-v1' || deps.sourceTree !== pins.treeSha ||
        !Number.isSafeInteger(deps.packageCount) || deps.packageCount <= 0 ||
        [deps.inputsSha256, deps.lockSha256, deps.toolchainSha256, deps.vendorSha256, deps.configSha256, deps.receiptSha256].some((value) => !DIGEST.test(value))) return 'Cargo dependency evidence or cleanup is missing';
    const { receiptSha256, ...payload } = deps;
    if (createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== receiptSha256) return 'Cargo dependency receipt digest is invalid';
  }
  if (run.expectedCommands.length === 0 || run.commands.length !== run.expectedCommands.length) return 'no complete base-derived command suite ran';
  for (let i = 0; i < run.expectedCommands.length; i++) {
    const expected = run.expectedCommands[i]!;
    const actual = run.commands[i]!;
    if (expected.cmd.length === 0 || maintainerEvidenceDigest(expected) !== maintainerEvidenceDigest(actual.command)) return 'executed command differs from the base contract';
    if (!actual.result.ok || actual.result.exitCode !== 0 || actual.result.timedOut || actual.result.cancelled) return 'a verification command failed or was interrupted';
    if (!Number.isFinite(actual.durationMs) || actual.durationMs < 0 || !Number.isFinite(Date.parse(actual.startedAt)) ||
        !DIGEST.test(actual.outputSha256) || actual.outputSha256 !== createHash('sha256').update(actual.result.output).digest('hex')) {
      return 'executed command output/timing evidence is invalid';
    }
  }
  return null;
}

/** No saved-receipt import, no merge, and no branch-protection mutation. */
export async function verifyMaintainerPr(input: { repo: string; pr: number; confirmHead: string }, deps: MaintainerVerificationDeps): Promise<MaintainerVerificationResult> {
  let receipt: MaintainerVerificationReceipt | undefined;
  try {
    if (!REPO.test(input.repo) || !Number.isSafeInteger(input.pr) || input.pr <= 0 || !SHA.test(input.confirmHead)) throw new Error('repo, PR and explicit reviewed head are required');
    const policy = requirePolicy(input.repo, deps);
    const initialPolicySha256 = policyDigest(policy);
    const initialKillEpoch = deps.killEpoch();
    const actor = await deps.authenticatedActor();
    if (!ACTOR.test(actor)) throw new Error('authenticated maintainer identity is unavailable');
    const initial = await observe(input.repo, input.pr, actor, deps);
    if (initial.source.headSha !== input.confirmHead) throw new Error('PR head differs from the explicitly reviewed head');
    if (policyDigest(requirePolicy(input.repo, deps)) !== initialPolicySha256 || deps.killEpoch() !== initialKillEpoch) {
      throw new Error('signed authority changed during PR intake');
    }
    const authority = {
      grantId: policy.grantId, grantSeq: policy.grantSeq, policySha256: initialPolicySha256,
      killEpoch: initialKillEpoch, rulesSha256: initial.rulesSha256, appId: initial.appId,
    };
    const startedAt = new Date(deps.nowMs()).toISOString();
    const run = await deps.run(initial.source);
    const payload = { v: 2 as const, kind: 'maintainer-pr-verification' as const, actor, source: initial.source, authority, startedAt, finishedAt: new Date(deps.nowMs()).toISOString(), run };
    receipt = { ...payload, receiptSha256: maintainerEvidenceDigest(payload) };
    deps.record(receipt);
    const failure = maintainerRunFailure(initial.source, run);
    if (failure) return { ok: false, reason: failure, receipt };
    return await deps.fenced(async () => {
      const currentPolicy = requirePolicy(input.repo, deps);
      if (await deps.authenticatedActor() !== actor) throw new Error('authenticated maintainer account changed during verification');
      const fresh = await observe(input.repo, input.pr, actor, deps);
      if (policyDigest(currentPolicy) !== authority.policySha256 || deps.killEpoch() !== authority.killEpoch ||
          fresh.rulesSha256 !== authority.rulesSha256 || fresh.appId !== authority.appId ||
          maintainerEvidenceDigest(fresh.source) !== maintainerEvidenceDigest(initial.source)) {
        return { ok: false, reason: 'source, rules or signed authority changed during verification', receipt };
      }
      // Replay is recognized only after this invocation actually verified and
      // rechecked the exact pins; a saved JSON receipt cannot reach this path.
      const checks = object(await read(deps, input.repo, `/commits/${input.confirmHead}/check-runs?check_name=${encodeURIComponent(ASHLR_VERIFY_CHECK_NAME)}&per_page=100`))?.['check_runs'];
      if (!Array.isArray(checks)) throw new Error('existing check runs are unavailable');
      const assertPublicationActive = (): void => {
        if (!deps.publicationFenceHeld() || policyDigest(requirePolicy(input.repo, deps)) !== authority.policySha256 || deps.killEpoch() !== authority.killEpoch) {
          throw new Error('authority or publication fence changed before check publication');
        }
      };
      assertPublicationActive();
      // A check's identity is stable across fresh successful executions of
      // the same source/contract/authority. Timing and output belong to each
      // unique receipt, not the idempotency key.
      const externalId = `maintainer-v2:${maintainerEvidenceDigest({
        source: initial.source, actor, authority, diffSha256: run.diffSha256,
        contractSha256: run.contractSha256, commands: run.expectedCommands,
        ...(run.cargoDependencies ? { cargo: { recipe: run.cargoDependencies.recipe, inputsSha256: run.cargoDependencies.inputsSha256,
          lockSha256: run.cargoDependencies.lockSha256, toolchainSha256: run.cargoDependencies.toolchainSha256, vendorSha256: run.cargoDependencies.vendorSha256 } } : {}),
      })}`;
      const prior = checks.find((item) => {
        const check = object(item);
        return check?.['external_id'] === externalId && check['head_sha'] === input.confirmHead && check['name'] === ASHLR_VERIFY_CHECK_NAME &&
          check['conclusion'] === 'success' && check['status'] === 'completed' && object(check['app'])?.['id'] === authority.appId &&
          Number.isSafeInteger(check['id']) && Number(check['id']) > 0;
      });
      if (prior) return { ok: true, receipt: receipt!, action: 'unchanged', check: { id: Number(object(prior)!['id']), appId: authority.appId, headSha: input.confirmHead } };
      // Recheck Stop/authority after the final awaited read, immediately before
      // the outward request. The host fence remains held through that request.
      assertPublicationActive();
      const lines = run.commands.map((command) => `- ${command.command.kind}: \`${scrubSecrets(command.command.cmd.join(' ')).replace(/[`\r\n]/g, ' ').slice(0, 500)}\` — exit ${command.result.exitCode}, output \`${command.outputSha256}\``);
      const reply = await request(deps, input.repo, '/check-runs', {
        name: ASHLR_VERIFY_CHECK_NAME, head_sha: input.confirmHead, external_id: externalId,
        status: 'completed', conclusion: 'success', completed_at: new Date(deps.nowMs()).toISOString(),
        output: {
          title: 'Maintainer PR verified on the exact head tree',
          summary: `${run.commands.length} base-derived commands passed under required confinement. Current protected base, maintainer identity, signed scope and active App rules were rechecked. This check does not merge or deploy.`,
          text: [`Head: \`${input.confirmHead}\``, `Tree: \`${run.treeSha}\``, `Base/merge base: \`${run.baseSha}\``, `Diff: \`${run.diffSha256}\``, `Contract: \`${run.contractSha256}\``, `Receipt: \`${receipt!.receiptSha256}\``, '', 'Commands executed in a private confined worktree:', ...lines].join('\n').slice(0, 60_000),
        },
      }, assertPublicationActive);
      const check = object(reply.body);
      if (![200, 201].includes(reply.status) || check?.['name'] !== ASHLR_VERIFY_CHECK_NAME || check['head_sha'] !== input.confirmHead ||
          check['external_id'] !== externalId || check['conclusion'] !== 'success' || check['status'] !== 'completed' ||
          object(check['app'])?.['id'] !== authority.appId || !Number.isSafeInteger(check['id']) || Number(check['id']) <= 0) {
        throw new Error('GitHub did not confirm the exact check from the ruleset-bound App');
      }
      return { ok: true, receipt: receipt!, action: 'created', check: { id: Number(check['id']), appId: authority.appId, headSha: input.confirmHead } };
    });
  } catch (error) {
    return { ok: false, reason: scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 600), ...(receipt ? { receipt } : {}) };
  }
}
