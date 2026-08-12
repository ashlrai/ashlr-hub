/**
 * goal.ts — M55 (v5 Open Fleet): the `ashlr goal` conductor.
 *
 * One polished front door to the goal machinery: `ashlr goal "<objective>"`
 * creates a goal, plans it into milestones, and advances the next one — routed
 * across the polyglot roster (M50/M51/M53), sandboxed, PROPOSAL-FIRST. It is a
 * thin convenience wrapper over the PROVEN, gated `ashlr goals` subcommands
 * (add → plan → advance); it adds NO new dispatch or mutation path. The
 * proposal-only + enrollment + kill-switch gates all live in core advanceGoal.
 *
 * --direct mode (M84): skip milestone decomposition entirely. Runs the verbatim
 * objective as a SINGLE sandboxed, proposal-only frontier-engine run — the
 * SAME path the daemon uses for non-builtin backends (runGoal -> sandboxEngine ->
 * runEngineSandboxed -> worktree diff -> PENDING inbox proposal). Requires --project.
 *
 * SAFETY: this module imports no outward-mutation primitive — it never applies
 * proposals, opens pull requests, pushes a remote, or deploys. It only sequences
 * the already-gated goals flow.
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeColors } from './ui.js';
import type { AshlrConfig, Proposal, RunBudget, RunOptions, RunState, WorkItem } from '../core/types.js';
import type { ListProposalsDetailedOptions, ProposalsReadResult } from '../core/inbox/store.js';

interface ParsedGoalArgs {
  objective: string;
  project?: string;
  allowCloud: boolean;
  planOnly: boolean;
  direct: boolean;
  json: boolean;
  usageError?: string;
  help: boolean;
}

type DirectProposalBlocker =
  | 'proposal-authority-invalid'
  | 'proposal-identity-mismatch'
  | 'proposal-outcome-not-filed'
  | 'proposal-read-failed'
  | 'proposal-run-ambiguous'
  | 'proposal-source-degraded'
  | 'productive-backend-unavailable'
  | 'run-ledger-mismatch'
  | 'run-ledger-unavailable'
  | 'run-not-done'
  | 'sandbox-unavailable'
  | 'run-summary-mismatch';

function exactFiledProposalId(state: RunState, requireTrajectory: boolean): string | null {
  if (state.status !== 'done') return null;
  if (requireTrajectory && state.trajectoryId !== `run:${state.id}`) return null;
  const outcome = state.proposalOutcome;
  if (
    outcome?.kind !== 'filed' ||
    outcome.isPartial === true ||
    typeof outcome.proposalId !== 'string' ||
    outcome.proposalId.length === 0
  ) return null;
  const summary = state.runEventSummary;
  if (
    summary?.runId !== state.id ||
    summary.status !== 'done' ||
    summary.outcome !== 'proposal-created' ||
    summary.proposalCreated !== true ||
    summary.proposalId !== outcome.proposalId
  ) return null;
  return outcome.proposalId;
}

function parseArgs(args: string[]): ParsedGoalArgs {
  const positional: string[] = [];
  let project: string | undefined;
  let allowCloud = false;
  let planOnly = false;
  let direct = false;
  let json = false;
  let usageError: string | undefined;
  let help = false;
  const seen = new Set<string>();
  const claim = (flag: string): boolean => {
    if (seen.has(flag)) {
      usageError ??= `duplicate option: ${flag}`;
      return false;
    }
    seen.add(flag);
    return true;
  };
  const valueAfter = (index: number, flag: string): string | undefined => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      usageError ??= `${flag} requires a value`;
      return undefined;
    }
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--project' || a === '-p') {
      if (claim('--project')) project = valueAfter(i, '--project');
      if (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i++;
    }
    else if (a === '--allow-cloud') { claim(a); allowCloud = true; }
    else if (a === '--plan-only') { claim(a); planOnly = true; }
    else if (a === '--direct') { claim(a); direct = true; }
    else if (a === '--json') { claim(a); json = true; }
    else if (a === '--help' || a === '-h') help = true;
    else if (a.startsWith('-')) usageError ??= `unknown option: ${a}`;
    else positional.push(a);
  }
  if (direct && planOnly) usageError ??= '--direct and --plan-only cannot be combined';
  if (!direct && json) {
    usageError ??= '--json requires --direct';
  }
  return {
    objective: positional.join(' ').trim(), project, allowCloud, planOnly, direct,
    json, usageError, help,
  };
}

const USAGE =
  'Usage: ashlr goal "<objective>" [--project <repo>] [--allow-cloud] [--plan-only] [--direct [--json]]\n' +
  '\n' +
  '  Create a goal, plan it into milestones, and advance the next one as a\n' +
  '  sandboxed, PROPOSAL-ONLY run (review it via `ashlr inbox`). Routed across\n' +
  '  the polyglot backend roster by capability + trust tier.\n' +
  '\n' +
  '  --direct  Skip milestone decomposition. Run the objective verbatim as a\n' +
  '            SINGLE sandboxed proposal-only frontier-engine run (same path as\n' +
  '            the daemon\'s non-builtin dispatch). Requires --project.\n' +
  '            Ideal for concrete tasks that need no Design→Implement→Test split.\n' +
  '  --json          Emit one bounded machine-readable direct-run result.';

// ---------------------------------------------------------------------------
// --direct path: one sandboxed proposal-only frontier-engine run, verbatim.
// ---------------------------------------------------------------------------

/** Configured direct-run budget; external CLI usage can only be observed after an invocation. */
const DIRECT_BUDGET: RunBudget = {
  maxTokens: 200_000,
  maxSteps: 40,
  allowCloud: false,
};

interface DirectJsonResult {
  schemaVersion: 1;
  mode: 'direct-proposal';
  ok: boolean;
  terminalStage: 'usage' | 'admission' | 'run' | 'proposal-correlation';
  blockerCode: string | null;
  backend: string | null;
  runId: string | null;
  proposalId: string | null;
  usage: null;
  usageObserved: false;
  wrapperEffects: {
    inboxApplyInvoked: false;
    inboxMergeInvoked: false;
  };
  authority: {
    wrapperController: 'proposal-only';
    unattendedExecutionAuthorized: false;
    verificationProven: false;
    confinementAttested: false;
    environmentUnchangedAttested: false;
  };
}

function directJsonResult(
  input: Pick<DirectJsonResult, 'ok' | 'terminalStage' | 'blockerCode' | 'backend' | 'runId' | 'proposalId'>,
): DirectJsonResult {
  return {
    schemaVersion: 1,
    mode: 'direct-proposal',
    ok: input.ok,
    terminalStage: input.terminalStage,
    blockerCode: input.blockerCode,
    backend: input.backend,
    runId: input.runId,
    proposalId: input.proposalId,
    usage: null,
    usageObserved: false,
    wrapperEffects: {
      inboxApplyInvoked: false,
      inboxMergeInvoked: false,
    },
    authority: {
      wrapperController: 'proposal-only',
      unattendedExecutionAuthorized: false,
      verificationProven: false,
      confinementAttested: false,
      environmentUnchangedAttested: false,
    },
  };
}

function canonicalGoalCorrelationRepo(repo: string): string {
  try {
    return realpathSync.native(repo);
  } catch {
    return repo;
  }
}

async function runDirect(
  objective: string,
  project: string,
  allowCloud: boolean,
  json: boolean,
  col: ReturnType<typeof makeColors>,
): Promise<number> {
  const repo = resolve(project);
  const correlationRepo = canonicalGoalCorrelationRepo(repo);

  // Lazy-import the same frontier sandboxed path the daemon uses for non-builtin
  // backends (loop.ts:467): runGoal(..., { engine, sandboxEngine:true,
  // requireSandbox:true, cwd, budget, tools:true, noMemory:false }).
  // runGoal -> runEngineSandboxed -> worktree diff -> PENDING inbox proposal.
  // The proposal is correlated only through the exact run outcome and a
  // complete durable inbox snapshot. Repository recency is never authority.
  let runGoal: (goal: string, cfg: AshlrConfig, opts: RunOptions) => Promise<RunState>;
  let routeBackend: (item: WorkItem, cfg: AshlrConfig) => { backend: string };
  let loadRun: (id: string) => RunState | null;
  let listProposalsDetailed: (filter?: ListProposalsDetailedOptions) => ProposalsReadResult;
  let isAuthoritativeDurablePendingProposal: (
    proposal: Proposal | null | undefined,
    expected: {
      id: string;
      repo: string;
      origin: Proposal['origin'];
      kind: Proposal['kind'];
      runId: string;
      trajectoryId: string;
      workItemId: string;
      workItemGenerationId?: string;
      isPartial: boolean;
    },
    cfg?: Pick<AshlrConfig, 'foundry'>,
  ) => proposal is Proposal;
  let loadConfig: () => AshlrConfig;
  let assertMayMutate: (repo: string) => void;

  const budget: RunBudget = {
    maxTokens: DIRECT_BUDGET.maxTokens,
    maxSteps: DIRECT_BUDGET.maxSteps,
    allowCloud,
  };

  try {
    const [orchestrator, router, inbox, pendingAuthority, config, policy] = await Promise.all([
      import('../core/run/orchestrator.js'),
      import('../core/fleet/router.js'),
      import('../core/inbox/store.js'),
      import('../core/inbox/pending-authority.js'),
      import('../core/config.js'),
      import('../core/sandbox/policy.js'),
    ]);
    runGoal = orchestrator.runGoal as typeof runGoal;
    loadRun = orchestrator.loadRun as typeof loadRun;
    routeBackend = router.routeBackend as typeof routeBackend;
    listProposalsDetailed = inbox.listProposalsDetailed as typeof listProposalsDetailed;
    isAuthoritativeDurablePendingProposal =
      pendingAuthority.isAuthoritativeDurablePendingProposal as typeof isAuthoritativeDurablePendingProposal;
    loadConfig = config.loadConfig as typeof loadConfig;
    assertMayMutate = policy.assertMayMutate as typeof assertMayMutate;
  } catch {
    if (json) {
      console.log(JSON.stringify(directJsonResult({
        ok: false,
        terminalStage: 'admission',
        blockerCode: 'direct-core-unavailable',
        backend: null,
        runId: null,
        proposalId: null,
      })));
      return 1;
    }
    process.stderr.write(
      col.red('error: ') + 'direct mode requires the M45 core (src/core/run/orchestrator.js).\n',
    );
    return 1;
  }

  // ENROLLMENT-SCOPED: enforce before any engine starts (mirrors advanceGoal).
  try {
    assertMayMutate(repo);
  } catch (err) {
    if (json) {
      console.log(JSON.stringify(directJsonResult({
        ok: false,
        terminalStage: 'admission',
        blockerCode: 'repo-admission-refused',
        backend: null,
        runId: null,
        proposalId: null,
      })));
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(col.red('error: ') + msg + '\n');
    return 1;
  }

  // Route to the best available frontier backend (same heuristic as the daemon).
  // routeBackend returns 'codex' or 'claude' when one is allowed+installed;
  // falls back to 'builtin' when neither is available.
  const syntheticItem: WorkItem = {
    id: `direct-${randomUUID()}`,
    repo,
    title: objective.slice(0, 80),
    detail: objective,
    source: 'self',
    value: 3,
    effort: 3,
    score: 0,
    tags: [],
    ts: new Date().toISOString(),
  };
  let cfg: AshlrConfig;
  let backend: string;
  try {
    cfg = loadConfig();
    backend = routeBackend(syntheticItem, cfg).backend;
  } catch {
    if (json) {
      console.log(JSON.stringify(directJsonResult({
        ok: false,
        terminalStage: 'admission',
        blockerCode: 'routing-unavailable',
        backend: null,
        runId: null,
        proposalId: null,
      })));
      return 1;
    }
    process.stderr.write(col.red('error: ') + 'direct route/config unavailable.\n');
    return 1;
  }
  if (backend === 'builtin') {
    if (json) {
      console.log(JSON.stringify(directJsonResult({
        ok: false,
        terminalStage: 'admission',
        blockerCode: 'productive-backend-unavailable',
        backend,
        runId: null,
        proposalId: null,
      })));
      return 1;
    }
    process.stderr.write(
      col.yellow('! ') + 'direct mode requires a productive sandboxed backend; builtin fallback was refused.\n',
    );
    return 1;
  }

  let runState: RunState;
  try {
    // SANDBOXED + PROPOSAL-ONLY — same invariant as the daemon's frontier dispatch.
    // sandboxEngine:true routes through runEngineSandboxed (worktree -> agent ->
    // diff -> PENDING proposal). requireSandbox:true aborts if sandbox creation
    // fails rather than falling back to an unsandboxed run.
    runState = await runGoal(objective, cfg, {
      engine: backend,
      sandboxEngine: true,
      requireSandbox: true,
      cwd: repo,
      budget,
      tools: true,
      noMemory: false,
      workItemId: syntheticItem.id,
    });
  } catch (err) {
    if (json) {
      console.log(JSON.stringify(directJsonResult({
        ok: false,
        terminalStage: 'run',
        blockerCode: 'run-failed',
        backend,
        runId: null,
        proposalId: null,
      })));
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(col.red('error: ') + msg + '\n');
    return 1;
  }

  // The producer's exact filed outcome is the only candidate identity. Reload a
  // complete durable snapshot, reject multiple rows for the same run, and prove
  // the signed pending authority envelope before reporting success.
  let proposalId: string | null = null;
  let blocker: DirectProposalBlocker = 'proposal-authority-invalid';
  const returnedProposalId = exactFiledProposalId(runState, false);
  if (runState.proposalOutcome?.kind === 'sandbox-unavailable') blocker = 'sandbox-unavailable';
  else if (runState.status !== 'done') blocker = 'run-not-done';
  else if (
    runState.proposalOutcome?.kind !== 'filed' ||
    runState.proposalOutcome.isPartial === true ||
    typeof runState.proposalOutcome.proposalId !== 'string'
  ) blocker = 'proposal-outcome-not-filed';
  else if (!returnedProposalId) blocker = 'run-summary-mismatch';
  else {
    let durableRun: RunState | null;
    try {
      durableRun = loadRun(runState.id);
    } catch {
      blocker = 'run-ledger-unavailable';
      durableRun = null;
    }
    const durableProposalId = durableRun ? exactFiledProposalId(durableRun, true) : null;
    if (!durableRun) blocker = 'run-ledger-unavailable';
    else if (
      !durableProposalId ||
      durableProposalId !== returnedProposalId ||
      durableRun.status !== runState.status
    ) blocker = 'run-ledger-mismatch';
    else {
      try {
        const read = listProposalsDetailed({ requireComplete: true });
        if (
          read.sourceState !== 'healthy' ||
          read.sourcePresent !== true ||
          read.complete !== true ||
          read.invalidFiles !== 0 ||
          read.unreadableFiles !== 0
        ) blocker = 'proposal-source-degraded';
        else {
          // Count every lifecycle state, origin, and kind carrying this run id.
          // A second row would make this run-to-proposal identity ambiguous even
          // if the expected pending patch also exists.
          const runProposals = read.proposals.filter((proposal) => proposal.runId === runState.id);
          if (runProposals.length !== 1) blocker = 'proposal-run-ambiguous';
          else {
            const exact = runProposals[0];
            if (exact?.id !== returnedProposalId) blocker = 'proposal-identity-mismatch';
            else if (!isAuthoritativeDurablePendingProposal(
              exact,
              {
                id: returnedProposalId,
                repo: correlationRepo,
                origin: 'agent',
                kind: 'patch',
                runId: runState.id,
                trajectoryId: `run:${runState.id}`,
                workItemId: syntheticItem.id,
                workItemGenerationId: undefined,
                isPartial: false,
              },
              cfg,
            )) blocker = 'proposal-authority-invalid';
            else {
              proposalId = exact.id;
            }
          }
        }
      } catch {
        blocker = 'proposal-read-failed';
      }
    }
  }

  if (proposalId) {
    if (json) {
      console.log(JSON.stringify(directJsonResult({
        ok: true,
        terminalStage: 'proposal-correlation',
        blockerCode: null,
        backend,
        runId: runState.id,
        proposalId,
      })));
      return 0;
    }
    console.log('');
    console.log(col.green('  ✓ ') + col.bold('proposal filed') + col.dim(` (${backend} run ${runState.id}, ${runState.status})`));
    console.log('');
    console.log('  An authoritative ' + col.bold('PENDING') + ' inbox proposal was correlated.');
    console.log(`  proposal: ${col.cyan(proposalId)}`);
    console.log('');
    console.log(col.dim('  owner-invoked path: the `goal --direct` wrapper did not invoke inbox apply or merge.'));
    console.log(col.dim('  review with `ashlr inbox`; source Git, remotes, and services are not independently attested unchanged.'));
    return 0;
  } else {
    if (json) {
      console.log(JSON.stringify(directJsonResult({
        ok: false,
        terminalStage: 'proposal-correlation',
        blockerCode: blocker,
        backend,
        runId: runState.id,
        proposalId: null,
      })));
      return 1;
    }
    process.stderr.write(
      col.yellow('! ') +
        `direct run completed (${backend} run ${runState.id}, status ${runState.status}) but produced no authoritative PENDING proposal [${blocker}].\n`,
    );
    process.stderr.write(col.dim('  Inspect `ashlr inbox` or check the engine output for details.\n'));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function cmdGoal(args: string[]): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);
  const parsed = parseArgs(args);

  if (parsed.usageError) {
    if (parsed.json) {
      console.log(JSON.stringify(directJsonResult({
        ok: false,
        terminalStage: 'usage',
        blockerCode: 'invalid-arguments',
        backend: null,
        runId: null,
        proposalId: null,
      })));
      return 2;
    }
    process.stderr.write(col.red('error: ') + parsed.usageError + '\n\n' + USAGE + '\n');
    return 2;
  }

  if (parsed.help || !parsed.objective) {
    if (!parsed.help && parsed.direct && parsed.json) {
      console.log(JSON.stringify(directJsonResult({
        ok: false,
        terminalStage: 'usage',
        blockerCode: 'objective-required',
        backend: null,
        runId: null,
        proposalId: null,
      })));
      return 2;
    }
    console.log(parsed.help ? USAGE : col.red('error: ') + 'an objective is required\n\n' + USAGE);
    return parsed.help ? 0 : 2;
  }

  // --direct: single sandboxed run, verbatim objective, no milestone planning.
  if (parsed.direct) {
    if (!parsed.project) {
      if (parsed.json) {
        console.log(JSON.stringify(directJsonResult({
          ok: false,
          terminalStage: 'usage',
          blockerCode: 'project-required',
          backend: null,
          runId: null,
          proposalId: null,
        })));
        return 2;
      }
      process.stderr.write(
        col.red('error: ') + '--direct requires --project <enrolled-repo>\n' +
          '         (the objective runs directly against the repo; no planning context is created).\n',
      );
      return 2;
    }

    if (!parsed.json) {
      console.log('');
      console.log(col.bold('  ashlr goal --direct') + col.dim(' — objective → single sandboxed frontier run → proposal'));
      console.log('  ' + col.cyan(parsed.objective));
      console.log('');
    }

    return runDirect(
      parsed.objective,
      parsed.project,
      parsed.allowCloud,
      parsed.json,
      col,
    );
  }

  // Reuse the proven, gated `ashlr goals` flow. cmdGoals routes advance through
  // core advanceGoal (sandboxed + proposal-only + enrollment/kill gated).
  const { cmdGoals } = await import('./goals.js');
  const { listGoals } = await import('../core/goals/store.js');

  console.log('');
  console.log(col.bold('  ashlr goal') + col.dim(' — objective → milestones → proposal'));
  console.log('  ' + col.cyan(parsed.objective));
  console.log('');

  // 1) Create the goal.
  const addArgs = ['add', parsed.objective];
  if (parsed.project) addArgs.push('--project', parsed.project);
  const addRc = await cmdGoals(addArgs);
  if (addRc !== 0) return addRc;

  // Resolve the goal we just created (newest matching objective).
  const mine = listGoals().filter((g) => g.objective === parsed.objective);
  const goal = mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!goal) {
    console.error(col.red('error: ') + 'could not resolve the created goal');
    return 1;
  }

  // 2) Plan it into milestones.
  const planRc = await cmdGoals(['plan', goal.id]);
  if (planRc !== 0) return planRc;

  if (parsed.planOnly) {
    console.log(col.dim('  planned only — run `ashlr goal` again or `ashlr goals advance ' + goal.id + '` to proceed.'));
    return 0;
  }

  // 3) Advance the next milestone — sandboxed, proposal-only.
  const advArgs = ['advance', goal.id];
  if (parsed.allowCloud) advArgs.push('--allow-cloud');
  const advRc = await cmdGoals(advArgs);
  if (advRc === 0) {
    console.log('');
    console.log(col.green('  ✓ ') + col.dim('proposal filed — review with `ashlr inbox`. Nothing was applied.'));
  }
  return advRc;
}
