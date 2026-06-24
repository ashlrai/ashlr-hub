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

import { resolve } from 'node:path';
import { makeColors } from './ui.js';
import type { AshlrConfig, RunBudget, WorkItem } from '../core/types.js';

interface ParsedGoalArgs {
  objective: string;
  project?: string;
  allowCloud: boolean;
  planOnly: boolean;
  direct: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedGoalArgs {
  const positional: string[] = [];
  let project: string | undefined;
  let allowCloud = false;
  let planOnly = false;
  let direct = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--project' || a === '-p') project = args[++i];
    else if (a === '--allow-cloud') allowCloud = true;
    else if (a === '--plan-only') planOnly = true;
    else if (a === '--direct') direct = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (!a.startsWith('-')) positional.push(a);
  }
  return { objective: positional.join(' ').trim(), project, allowCloud, planOnly, direct, help };
}

const USAGE =
  'Usage: ashlr goal "<objective>" [--project <repo>] [--allow-cloud] [--plan-only] [--direct]\n' +
  '\n' +
  '  Create a goal, plan it into milestones, and advance the next one as a\n' +
  '  sandboxed, PROPOSAL-ONLY run (review it via `ashlr inbox`). Routed across\n' +
  '  the polyglot backend roster by capability + trust tier.\n' +
  '\n' +
  '  --direct  Skip milestone decomposition. Run the objective verbatim as a\n' +
  '            SINGLE sandboxed proposal-only frontier-engine run (same path as\n' +
  '            the daemon\'s non-builtin dispatch). Requires --project.\n' +
  '            Ideal for concrete tasks that need no Design→Implement→Test split.';

// ---------------------------------------------------------------------------
// --direct path: one sandboxed proposal-only frontier-engine run, verbatim.
// ---------------------------------------------------------------------------

/** Hard per-direct-run budget — same defaults as advanceGoal's DEFAULT_ADVANCE_BUDGET. */
const DIRECT_BUDGET: RunBudget = {
  maxTokens: 200_000,
  maxSteps: 40,
  allowCloud: false,
};

async function runDirect(
  objective: string,
  project: string,
  allowCloud: boolean,
  col: ReturnType<typeof makeColors>,
): Promise<number> {
  const repo = resolve(project);

  // Lazy-import the same frontier sandboxed path the daemon uses for non-builtin
  // backends (loop.ts:467): runGoal(..., { engine, sandboxEngine:true,
  // requireSandbox:true, cwd, budget, tools:true, noMemory:false }).
  // runGoal -> runEngineSandboxed -> worktree diff -> PENDING inbox proposal.
  // The proposal is correlated post-run via listProposals (origin:'agent', repo).
  let runGoal: (
    goal: string,
    cfg: AshlrConfig,
    opts: {
      engine: string;
      sandboxEngine: boolean;
      requireSandbox: boolean;
      cwd: string;
      budget: RunBudget;
      tools: boolean;
      noMemory: boolean;
    },
  ) => Promise<{ id: string; status: string }>;
  let routeBackend: (item: WorkItem, cfg: AshlrConfig) => { backend: string };
  let listProposals: (filter: { status: string }) => Array<{
    id: string;
    origin: string;
    repo: string | null;
  }>;
  let loadConfig: () => AshlrConfig;
  let assertMayMutate: (repo: string) => void;

  try {
    const [orchestrator, router, inbox, config, policy] = await Promise.all([
      import('../core/run/orchestrator.js'),
      import('../core/fleet/router.js'),
      import('../core/inbox/store.js'),
      import('../core/config.js'),
      import('../core/sandbox/policy.js'),
    ]);
    runGoal = orchestrator.runGoal as typeof runGoal;
    routeBackend = router.routeBackend as typeof routeBackend;
    listProposals = inbox.listProposals as typeof listProposals;
    loadConfig = config.loadConfig as typeof loadConfig;
    assertMayMutate = policy.assertMayMutate as typeof assertMayMutate;
  } catch {
    process.stderr.write(
      col.red('error: ') + 'direct mode requires the M45 core (src/core/run/orchestrator.js).\n',
    );
    return 1;
  }

  // ENROLLMENT-SCOPED: enforce before any engine starts (mirrors advanceGoal).
  try {
    assertMayMutate(repo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(col.red('error: ') + msg + '\n');
    return 1;
  }

  const cfg = loadConfig();
  const budget: RunBudget = { ...DIRECT_BUDGET, allowCloud };

  // Route to the best available frontier backend (same heuristic as the daemon).
  // routeBackend returns 'codex' or 'claude' when one is allowed+installed;
  // falls back to 'builtin' when neither is available.
  const syntheticItem: WorkItem = {
    id: `direct-${Date.now().toString(36)}`,
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
  const { backend } = routeBackend(syntheticItem, cfg);

  // Snapshot PENDING count before the run so we can detect newly-filed proposals.
  let pendingBefore: Array<{ id: string; origin: string; repo: string | null }> = [];
  try {
    pendingBefore = listProposals({ status: 'pending' });
  } catch {
    pendingBefore = [];
  }

  let runState: { id: string; status: string };
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
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(col.red('error: ') + msg + '\n');
    return 1;
  }

  // Correlate the PENDING proposal filed by runEngineSandboxed — origin:'agent',
  // repo matches our target. Filter to proposals that didn't exist before the run.
  let proposalId: string | null = null;
  try {
    const beforeIds = new Set(pendingBefore.map((p) => p.id));
    const candidates = listProposals({ status: 'pending' }).filter(
      (p) => !beforeIds.has(p.id) && p.origin === 'agent' && p.repo === repo,
    );
    proposalId = candidates[0]?.id ?? null;
  } catch {
    /* best-effort read */
  }

  if (proposalId) {
    console.log('');
    console.log(col.green('  ✓ ') + col.bold('proposal filed') + col.dim(` (${backend} run ${runState.id}, ${runState.status})`));
    console.log('');
    console.log('  A ' + col.bold('PENDING') + ' inbox proposal was produced — nothing was applied.');
    console.log(`  proposal: ${col.cyan(proposalId)}`);
    console.log('');
    console.log(col.dim('  review with `ashlr inbox`. No real working tree was mutated, pushed, or deployed.'));
    return 0;
  } else {
    process.stderr.write(
      col.yellow('! ') +
        `direct run completed (${backend} run ${runState.id}, status ${runState.status}) but produced no PENDING proposal.\n`,
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

  if (parsed.help || !parsed.objective) {
    console.log(parsed.help ? USAGE : col.red('error: ') + 'an objective is required\n\n' + USAGE);
    return parsed.help ? 0 : 2;
  }

  // --direct: single sandboxed run, verbatim objective, no milestone planning.
  if (parsed.direct) {
    if (!parsed.project) {
      process.stderr.write(
        col.red('error: ') + '--direct requires --project <enrolled-repo>\n' +
          '         (the objective runs directly against the repo; no planning context is created).\n',
      );
      return 2;
    }

    console.log('');
    console.log(col.bold('  ashlr goal --direct') + col.dim(' — objective → single sandboxed frontier run → proposal'));
    console.log('  ' + col.cyan(parsed.objective));
    console.log('');

    return runDirect(parsed.objective, parsed.project, parsed.allowCloud, col);
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
