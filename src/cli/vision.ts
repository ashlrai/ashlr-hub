/**
 * M121: `ashlr vision` — Mason's touchpoint for the end-state spec + strategist.
 *
 * Subcommands:
 *   show [id]              Print the current EndStateSpec (default: ecosystem).
 *   review [--project P]   Run the Strategist → print strategic briefing.
 *   approve                adoptBriefing for the latest briefing → evolve spec + create goals.
 *   set --north-star "…"   Mason edits northStar directly (updatedBy:'mason').
 *   set --end-state "…"    Mason edits endState directly (updatedBy:'mason').
 *
 * Exit codes: 0 success, 1 error, 2 bad usage.
 */

import { loadConfig } from '../core/config.js';
import { loadSpec, applyEvolution } from '../core/vision/spec.js';
import type { EndStateSpec, SpecPriority } from '../core/vision/spec.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

function cyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}

function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}

function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}

function printSpec(spec: EndStateSpec): void {
  console.log('');
  console.log(bold(`=== End-State Spec: ${spec.id} ===`) + dim(` v${spec.version} | updated ${spec.updatedAt} by ${spec.updatedBy}`));
  console.log('');
  console.log(bold('North Star'));
  console.log('  ' + cyan(spec.northStar));
  console.log('');
  console.log(bold('End State'));
  console.log('  ' + spec.endState);
  console.log('');
  console.log(bold(`Principles (${spec.principles.length})`));
  spec.principles.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('');
  console.log(bold(`Priorities (${spec.priorities.length})`));
  spec.priorities
    .slice()
    .sort((a: SpecPriority, b: SpecPriority) => a.rank - b.rank)
    .forEach((p: SpecPriority) => {
      console.log(`  ${yellow(`#${p.rank}`)} ${bold(p.title)}`);
      console.log(`       ${dim(p.rationale)}`);
    });
  console.log('');
  console.log(bold(`Open Problems (${spec.openProblems.length})`));
  spec.openProblems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('');
  console.log(bold(`Ambition Level`) + ` ${spec.ambitionLevel}/10`);
  console.log('');
}

function printBriefing(b: import('../core/vision/strategist.js').StrategicBriefing): void {
  console.log('');
  console.log(bold('=== STRATEGIC BRIEFING ===') + dim(` ${b.generatedAt}${b.project ? ' | ' + b.project : ''}`));
  console.log('');
  console.log(bold('Current State'));
  console.log('  ' + b.currentState);
  console.log('');
  console.log(bold('Gap to Vision'));
  console.log('  ' + b.gapToVision);
  console.log('');

  if (b.recommendedDirection.length > 0) {
    console.log(bold('Recommended Direction'));
    b.recommendedDirection.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
    console.log('');
  }

  if (b.newProblems.length > 0) {
    console.log(bold('Newly Identified Problems'));
    b.newProblems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
    console.log('');
  }

  if (b.questionsForMason.length > 0) {
    console.log(bold(yellow('Questions for Mason')));
    b.questionsForMason.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
    console.log('');
  }

  if (b.proposedGoals.length > 0) {
    console.log(bold('Proposed Goals'));
    b.proposedGoals.forEach((g, i) => {
      console.log(`  ${green(`${i + 1}.`)} ${bold(g.objective)}`);
      if (g.rationale) console.log(`       ${dim(g.rationale)}`);
      if (g.specPriority) console.log(`       ${dim('serves: ' + g.specPriority)}`);
    });
    console.log('');
  }

  const hasEvolution = Object.keys(b.proposedEvolution).length > 0;
  if (hasEvolution) {
    console.log(bold('Proposed Spec Evolution'));
    if (b.proposedEvolution.northStar) console.log(`  northStar: ${cyan(b.proposedEvolution.northStar)}`);
    if (b.proposedEvolution.ambitionLevel !== undefined) console.log(`  ambitionLevel: ${b.proposedEvolution.ambitionLevel}/10`);
    if (b.proposedEvolution.priorities?.length) console.log(`  priorities: ${b.proposedEvolution.priorities.length} updated`);
    if (b.proposedEvolution.openProblems?.length) console.log(`  openProblems: ${b.proposedEvolution.openProblems.length} entries`);
    console.log('');
    console.log(dim('  Run `ashlr vision approve` to apply this evolution and create the proposed goals.'));
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function cmdShow(args: string[]): Promise<number> {
  const id = args[0] ?? 'ecosystem';
  const spec = loadSpec(id);
  if (!spec) {
    console.error(`vision: spec '${id}' not found. Use 'ashlr vision show' to see the ecosystem spec.`);
    return 1;
  }
  printSpec(spec);
  return 0;
}

async function cmdReview(args: string[]): Promise<number> {
  let project: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      project = args[i + 1]!;
      i++;
    }
  }

  const cfg = loadConfig();
  const { runStrategist } = await import('../core/vision/strategist.js');

  console.log(dim('Running strategist... (this may take a moment)'));
  const briefing = await runStrategist(cfg, { project });
  printBriefing(briefing);
  return 0;
}

async function cmdApprove(_args: string[]): Promise<number> {
  const cfg = loadConfig();
  const { loadLatestBriefing, adoptBriefing } = await import('../core/vision/strategist.js');

  const briefing = loadLatestBriefing();
  if (!briefing) {
    console.error('vision: no briefing found. Run `ashlr vision review` first.');
    return 1;
  }

  console.log(dim(`Adopting briefing from ${briefing.generatedAt}...`));
  const result = await adoptBriefing(cfg, briefing, { by: 'mason' });

  const specId = result.specId;
  const goalCount = result.goalIds.length;
  console.log(green(`Spec '${specId}' evolved successfully.`));
  if (goalCount > 0) {
    console.log(green(`Created ${goalCount} goal(s): ${result.goalIds.join(', ')}`));
  } else {
    console.log(dim('No goals created (briefing had no proposedGoals).'));
  }
  return 0;
}

async function cmdSet(args: string[]): Promise<number> {
  let northStar: string | undefined;
  let endState: string | undefined;
  let specId = 'ecosystem';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--north-star' && args[i + 1]) {
      northStar = args[i + 1];
      i++;
    } else if (args[i] === '--end-state' && args[i + 1]) {
      endState = args[i + 1];
      i++;
    } else if (args[i] === '--id' && args[i + 1]) {
      specId = args[i + 1]!;
      i++;
    }
  }

  if (!northStar && !endState) {
    console.error('vision set: requires --north-star or --end-state');
    return 2;
  }

  const partial: Parameters<typeof applyEvolution>[1] = {};
  if (northStar) partial.northStar = northStar;
  if (endState) partial.endState = endState;

  const summary = northStar
    ? `Mason set northStar: "${northStar.slice(0, 60)}${northStar.length > 60 ? '...' : ''}"`
    : `Mason set endState.`;

  const spec = applyEvolution(specId, partial, 'mason', summary);
  console.log(green(`Spec '${spec.id}' updated to v${spec.version}.`));
  if (northStar) console.log(`  northStar: ${cyan(spec.northStar)}`);
  return 0;
}

function cmdVisionHelp(): void {
  console.log(`
Usage: ashlr vision <subcommand> [options]

Subcommands:
  show [id]              Print the EndStateSpec (default: ecosystem).
  review [--project P]   Run the Strategist agent — state, gap, recommendations, proposed goals.
  approve                Apply the latest briefing: evolve spec + create goals.
  set --north-star "…"   Update the north star directly (Mason-owned edit).
  set --end-state "…"    Update the end state directly.
  set --id <specId>      Target a specific spec (default: ecosystem).

Examples:
  ashlr vision show
  ashlr vision review
  ashlr vision review --project my-repo
  ashlr vision approve
  ashlr vision set --north-star "Build the world's best autonomous engineering fleet."
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function cmdVision(args: string[]): Promise<number> {
  const [sub, ...rest] = args;

  if (!sub || sub === '--help' || sub === 'help') {
    cmdVisionHelp();
    return 0;
  }

  switch (sub) {
    case 'show':
      return cmdShow(rest);
    case 'review':
      return cmdReview(rest);
    case 'approve':
      return cmdApprove(rest);
    case 'set':
      return cmdSet(rest);
    default:
      console.error(`vision: unknown subcommand '${sub}'. Run 'ashlr vision --help' for usage.`);
      return 2;
  }
}
