/**
 * M121: `ashlr vision` — Mason's touchpoint for the end-state spec + strategist.
 *
 * Subcommands:
 *   show [id]              Print the current EndStateSpec (default: ecosystem).
 *   review [--project P]   Run the Strategist → print strategic briefing.
 *   preview                Compile the latest briefing into a read-only adoption plan.
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

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}

function visionHoldReason(reason: string): string {
  const labels: Record<string, string> = {
    'goal-source-degraded': 'goal records could not be read safely',
    'briefing-goal-cap': 'briefing goal limit reached',
    'goal-focus-cap': 'active-goal limit reached',
    'duplicate-existing-goal': 'this goal already exists',
    'goal-id-collision': 'a goal with this stable identity already exists',
    'target-not-enrolled': 'target repository is not enrolled',
    'target-ambiguous': 'target repository name is ambiguous',
    'target-invalid': 'target repository is invalid',
    'dependency-blocked': 'an upstream mission node is not realized',
    'human-gate-required': 'an authorized human decision is required',
    'mission-graph-invalid': 'the mission dependency graph is invalid',
    'mission-reconcile-cap': 'this bounded reconciliation reached its limit',
    'goal-store-write-failed': 'the local goal record could not be persisted',
    'adoption-failed': 'mission adoption could not be completed safely',
  };
  return labels[reason] ?? reason;
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
      if (g.targetRepo !== undefined) {
        console.log(`       ${dim('target: ' + (g.targetRepo ?? 'ecosystem-wide (planning only)'))}`);
      }
      if (g.key) console.log(`       ${dim('mission node: ' + g.key)}`);
      if (g.dependsOn?.length) console.log(`       ${dim('depends on: ' + g.dependsOn.join(', '))}`);
      if (g.deliverable) console.log(`       ${dim('deliverable: ' + g.deliverable)}`);
      if (g.acceptanceEvidence?.length) {
        console.log(`       ${dim('acceptance evidence: ' + g.acceptanceEvidence.join(' · '))}`);
      }
      if (g.outcome?.desiredOutcome) console.log(`       ${dim('outcome: ' + g.outcome.desiredOutcome)}`);
      if (g.outcome?.successSignals.length) {
        console.log(`       ${dim('success signals: ' + g.outcome.successSignals.join(' · '))}`);
      }
      if (g.outcome?.guardrails.length) {
        console.log(`       ${dim('guardrails: ' + g.outcome.guardrails.join(' · '))}`);
      }
      if (g.humanGate) console.log(`       ${yellow('human gate required')}`);
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
  const { readLatestBriefingDetailed, adoptBriefing } = await import('../core/vision/strategist.js');

  const read = readLatestBriefingDetailed();
  if (read.sourceState === 'degraded') {
    console.error(`vision: briefing source is degraded (${read.reason}); no planning state was changed.`);
    return 1;
  }
  const briefing = read.briefing;
  if (!briefing) {
    console.error('vision: no briefing found. Run `ashlr vision review` first.');
    return 1;
  }

  console.log(dim(`Adopting briefing from ${briefing.generatedAt}...`));
  const result = await adoptBriefing(cfg, briefing, { by: 'mason' });

  if (result.specOutcome === 'persisted') {
    console.log(green(`Spec '${result.specId}' evolution persisted.`));
  } else if (result.specOutcome === 'failed') {
    console.error(red(`Spec '${result.specId}' evolution could not be verified as persisted.`));
  } else {
    console.log(dim('No spec evolution requested.'));
  }
  if (result.createdCount > 0) {
    console.log(green(`Created ${result.createdCount} goal(s): ${result.goalIds.join(', ')}`));
  } else {
    console.log(dim('No goals created.'));
  }
  const failed = result.outcomes.filter((outcome) => outcome.outcome === 'failed');
  if (failed.length > 0) {
    console.error(red(`Failed to persist ${failed.length} proposed goal(s):`));
    for (const outcome of failed) {
      console.error(`  ${outcome.index + 1}. ${visionHoldReason(outcome.reason)} ${dim(outcome.objective)}`);
    }
  }
  const skipped = result.outcomes.filter((outcome) => outcome.outcome === 'skipped');
  if (skipped.length > 0) {
    console.log(yellow(`Skipped ${skipped.length} proposed goal(s):`));
    for (const outcome of skipped) {
      console.log(`  ${outcome.index + 1}. ${visionHoldReason(outcome.reason)} ${dim(outcome.objective)}`);
    }
  }
  const degradedSource = skipped.some((outcome) => outcome.reason === 'goal-source-degraded');
  return result.failedCount > 0 || result.specOutcome === 'failed' || degradedSource ? 1 : 0;
}

async function cmdReconcile(_args: string[]): Promise<number> {
  const cfg = loadConfig();
  const [{ readLatestBriefingDetailed, adoptBriefing }, policy] = await Promise.all([
    import('../core/vision/strategist.js'),
    import('../core/sandbox/policy.js'),
  ]);
  const read = readLatestBriefingDetailed();
  if (read.sourceState === 'degraded') {
    console.error(`vision: briefing source is degraded (${read.reason}); no goal was created.`);
    return 1;
  }
  const briefing = read.briefing;
  if (!briefing) {
    console.error('vision: no briefing found. Run `ashlr vision review` first.');
    return 1;
  }
  const enrollment = policy.readEnrollmentRegistry();
  if (enrollment.state === 'degraded') {
    console.error(`vision: enrollment authority is degraded (${enrollment.reason}); no goal was created.`);
    return 1;
  }

  console.log(dim(`Reconciling dependency-ready mission work from ${briefing.generatedAt}...`));
  const result = await adoptBriefing(cfg, briefing, {
    by: 'mason',
    enrolledRepos: enrollment.repos,
    goalsOnly: true,
    maxCreatedGoals: 1,
  });
  if (result.createdCount > 0) {
    console.log(green(`Materialized ${result.createdCount} dependency-ready goal: ${result.goalIds.join(', ')}`));
  } else {
    console.log(dim('No dependency-ready mission goal was materialized.'));
  }
  for (const outcome of result.outcomes.filter((entry) => entry.outcome !== 'created')) {
    const marker = outcome.outcome === 'failed' ? red('FAILED') : yellow('HELD');
    console.log(`  ${marker} ${outcome.objective}`);
    console.log(`         ${dim(visionHoldReason(outcome.reason))}`);
  }
  console.log(dim('Planning-only reconciliation: no dispatch, proposal, merge, deployment, or publication authority changed.'));
  const degraded = result.outcomes.some((outcome) =>
    outcome.reason === 'goal-source-degraded' || outcome.outcome === 'failed',
  ) || result.preview.missionGraph?.state === 'invalid';
  return degraded ? 1 : 0;
}

async function cmdPreview(_args: string[]): Promise<number> {
  const cfg = loadConfig();
  const [strategist, goals, completion, focus, policy] = await Promise.all([
    import('../core/vision/strategist.js'),
    import('../core/goals/store.js'),
    import('../core/goals/completion.js'),
    import('../core/goals/focus.js'),
    import('../core/sandbox/policy.js'),
  ]);
  const read = strategist.readLatestBriefingDetailed();
  if (read.sourceState === 'degraded') {
    console.error(`vision: briefing source is degraded (${read.reason}); preview unavailable.`);
    return 1;
  }
  const briefing = read.briefing;
  if (!briefing) {
    console.error('vision: no briefing found. Run `ashlr vision review` first.');
    return 1;
  }

  const inventory = goals.listGoalsDetailed();
  const enrollment = policy.readEnrollmentRegistry();
  if (enrollment.state === 'degraded') {
    console.error(`vision: enrollment authority is degraded (${enrollment.reason}); preview unavailable.`);
    return 1;
  }
  const milestoneComplete = completion.createProposalMilestoneCompletionPredicate();
  const preview = strategist.previewBriefingAdoption(briefing, {
    enrolledRepos: enrollment.repos,
    existingGoals: inventory.goals,
    goalSourceState: inventory.sourceState,
    activeThreshold: focus.goalFocusActiveThreshold(cfg),
    goalRealized: (goal) => {
      const required = goal.milestones.filter((milestone) => milestone.status !== 'skipped');
      return required.length > 0 && required.every((milestone) => milestoneComplete(milestone, goal));
    },
  });
  console.log(bold('Mission compiler preview'));
  console.log(
    dim(
      `${preview.createCount} ready, ${preview.skippedCount} skipped · ` +
      `${preview.openGoalCount}/${preview.activeThreshold} open-goal slots occupied`,
    ),
  );
  for (const entry of preview.entries) {
    const marker = entry.disposition === 'create' ? green('CREATE') : yellow('SKIP');
    const target = entry.project ?? entry.targetRepo ?? 'ecosystem-wide';
    console.log(`  ${marker} ${entry.objective}`);
    console.log(`         ${dim(`${visionHoldReason(entry.reason)} · ${target}`)}`);
    const proposed = briefing.proposedGoals[entry.index];
    if (proposed?.key) {
      const dependencies = proposed.dependsOn?.length ? ` · waits for ${proposed.dependsOn.join(', ')}` : '';
      console.log(`         ${dim(`node ${proposed.key}${dependencies}`)}`);
    }
    if (proposed?.outcome?.desiredOutcome) {
      console.log(`         ${dim(`outcome: ${proposed.outcome.desiredOutcome}`)}`);
    }
    if (proposed?.deliverable) console.log(`         ${dim(`deliverable: ${proposed.deliverable}`)}`);
    if (proposed?.acceptanceEvidence?.length) {
      console.log(`         ${dim(`acceptance evidence: ${proposed.acceptanceEvidence.join(' · ')}`)}`);
    }
    if (proposed?.outcome?.successSignals.length) {
      console.log(`         ${dim(`success signals: ${proposed.outcome.successSignals.join(' · ')}`)}`);
    }
    if (proposed?.outcome?.guardrails.length) {
      console.log(`         ${dim(`guardrails: ${proposed.outcome.guardrails.join(' · ')}`)}`);
    }
    if (proposed?.humanGate === true) console.log(`         ${yellow('human gate required')}`);
  }
  console.log(dim('Read-only preview: no spec, goal, repository, proposal, or authority was changed.'));
  return preview.goalSourceState === 'degraded' || preview.missionGraph?.state === 'invalid' ? 1 : 0;
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
  preview                Read-only compile: exact targets, dedupe, caps, and skip reasons.
  approve                Apply the latest briefing: evolve spec + create goals.
  reconcile              Materialize at most one newly dependency-ready goal; planning-only.
  set --north-star "…"   Update the north star directly (Mason-owned edit).
  set --end-state "…"    Update the end state directly.
  set --id <specId>      Target a specific spec (default: ecosystem).

Examples:
  ashlr vision show
  ashlr vision review
  ashlr vision review --project my-repo
  ashlr vision preview
  ashlr vision approve
  ashlr vision reconcile
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
    case 'preview':
      return cmdPreview(rest);
    case 'approve':
      return cmdApprove(rest);
    case 'reconcile':
      return cmdReconcile(rest);
    case 'set':
      return cmdSet(rest);
    default:
      console.error(`vision: unknown subcommand '${sub}'. Run 'ashlr vision --help' for usage.`);
      return 2;
  }
}
