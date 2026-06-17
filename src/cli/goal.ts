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
 * SAFETY: this module imports no outward-mutation primitive — it never applies
 * proposals, opens pull requests, pushes a remote, or deploys. It only sequences
 * the already-gated goals flow.
 */

import { makeColors } from './ui.js';

interface ParsedGoalArgs {
  objective: string;
  project?: string;
  allowCloud: boolean;
  planOnly: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedGoalArgs {
  const positional: string[] = [];
  let project: string | undefined;
  let allowCloud = false;
  let planOnly = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--project' || a === '-p') project = args[++i];
    else if (a === '--allow-cloud') allowCloud = true;
    else if (a === '--plan-only') planOnly = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (!a.startsWith('-')) positional.push(a);
  }
  return { objective: positional.join(' ').trim(), project, allowCloud, planOnly, help };
}

const USAGE =
  'Usage: ashlr goal "<objective>" [--project <repo>] [--allow-cloud] [--plan-only]\n' +
  '\n' +
  '  Create a goal, plan it into milestones, and advance the next one as a\n' +
  '  sandboxed, PROPOSAL-ONLY run (review it via `ashlr inbox`). Routed across\n' +
  '  the polyglot backend roster by capability + trust tier.';

export async function cmdGoal(args: string[]): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);
  const parsed = parseArgs(args);

  if (parsed.help || !parsed.objective) {
    console.log(parsed.help ? USAGE : col.red('error: ') + 'an objective is required\n\n' + USAGE);
    return parsed.help ? 0 : 2;
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
