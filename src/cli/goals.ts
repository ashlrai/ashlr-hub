/**
 * CLI handler for `ashlr goals` — M28 GOAL PLANNING & SCHEDULING (Ashlr v2
 * pillar F).
 *
 * High-level OBJECTIVES decompose into ordered MILESTONES; each milestone maps
 * to a versioned spec; advancing a milestone runs a SANDBOXED, PROPOSAL-ONLY
 * swarm (the exact M21/M24 pattern), producing a PENDING inbox proposal a human
 * approves later. Milestones are TRACKED and STEERABLE (add/edit/reorder/pause/
 * skip). The DEFAULT path is local + deterministic + read-mostly.
 *
 * Usage:
 *   ashlr goals add "<objective>" [--project <enrolled-repo>]
 *   ashlr goals list [--json]
 *   ashlr goals show <id> [--json]
 *   ashlr goals plan <id> [--allow-cloud] [--max <n>]   # decompose + author specs
 *   ashlr goals advance <id>                            # sandboxed, proposal-only run of the NEXT milestone
 *   ashlr goals status [--json]                         # tracking dashboard
 *   ashlr goals recover-stale [--dry-run] [--max <n>]    # reset stale in-progress lanes
 *   ashlr goals pause <id> [milestone]
 *   ashlr goals resume <id> [milestone]
 *   ashlr goals skip <id> <milestone>
 *   ashlr goals reorder <id> <m1> <m2> ...
 *   ashlr goals delete <id>
 *
 * HARD SAFETY INVARIANTS (M28) enforced by this surface:
 *  1. SANDBOXED + PROPOSAL-ONLY: `advance` routes to core advanceGoal(), which
 *     ALWAYS calls runSwarm with { sandbox:true, requireSandbox:true,
 *     propose:true } + a hard budget. This CLI contains NO applyProposal /
 *     setStatus(approved) / git push / createPr / deploy.
 *  2. ENROLLMENT-SCOPED: `add --project <repo>` and `advance` resolve() the
 *     repo and filter through isEnrolled() HERE (CLI layer) AND again in core
 *     (advanceGoal -> assertMayMutate); a non-enrolled path HARD-ERRORS (exit 1)
 *     before any swarm starts. (M25 lesson: filter at BOTH layers.)
 *  3. LOCAL-FIRST: `plan` is deterministic by default; --allow-cloud (off by
 *     default) opens the local-first provider chain (cloud only with a key) and
 *     prints a warning, mirroring reflect.ts / ask.ts.
 *  4. STEERABLE + BOUNDED: no auto-advance loop — `advance` is an explicit,
 *     single-milestone action. `plan` is bounded by --max.
 *  5. READ-ONLY TRACKING: `list`/`show`/`status` only READ ~/.ashlr/goals +
 *     swarm/inbox state; they mutate nothing.
 *
 * Exit codes: 0 success, 1 runtime error / not-enrolled, 2 bad usage.
 */

import { resolve } from 'node:path';
import { pad, makeColors, isTty } from './ui.js';
import { parsePositiveInt } from './args.js';
import type {
  AdvanceOptions,
  AshlrConfig,
  DecomposeOptions,
  Goal,
  GoalProgress,
  Milestone,
  MilestoneStatus,
  SpecArtifact,
  SwarmRun,
} from '../core/types.js';

// ─── Lazy imports (graceful degradation if M28 core not yet built) ───────────

type CreateGoalFn = (objective: string, opts?: { project?: string | null }) => Goal;
type LoadGoalFn = (id: string) => Goal | null;
type ListGoalsFn = () => Goal[];
type AddMilestoneFn = (
  goalId: string,
  milestone: Pick<Milestone, 'title' | 'detail'>,
) => Goal | null;
type UpdateMilestoneStatusFn = (
  goalId: string,
  milestoneId: string,
  status: MilestoneStatus,
  link?: { swarmId?: string | null; proposalId?: string | null; specId?: string | null },
) => Goal | null;
type PauseMilestoneFn = (goalId: string, milestoneId?: string) => Goal | null;
type ResumeMilestoneFn = (goalId: string, milestoneId?: string) => Goal | null;
type SkipMilestoneFn = (goalId: string, milestoneId: string) => Goal | null;
type DecomposeGoalFn = (
  objective: string,
  cfg: AshlrConfig,
  opts?: DecomposeOptions,
) => Promise<Milestone[]>;
type PlanMilestoneSpecFn = (
  goal: Goal,
  milestone: Milestone,
  cfg: AshlrConfig,
  opts?: { allowCloud?: boolean },
) => Promise<SpecArtifact>;
type ReorderMilestonesFn = (goalId: string, orderedIds: string[]) => Goal | null;
type ClearMilestonesFn = (goalId: string) => Goal | null;
type DeleteGoalFn = (id: string) => void;
type RecoverStaleGoalLanesFn = (opts?: {
  limit?: number;
  dryRun?: boolean;
}) => {
  generatedAt: string;
  dryRun: boolean;
  eligible: number;
  recovered: number;
  lanes: {
    goalId: string;
    milestoneId: string;
    project: string | null;
    title: string;
    ageMs: number;
  }[];
};
type AdvanceGoalFn = (
  goalId: string,
  cfg: AshlrConfig,
  opts?: AdvanceOptions,
) => Promise<SwarmRun>;
type ProgressOfFn = (goal: Goal) => GoalProgress;
type IsEnrolledFn = (repo: string) => boolean;

interface GoalsCore {
  createGoal: CreateGoalFn;
  loadGoal: LoadGoalFn;
  listGoals: ListGoalsFn;
  addMilestone: AddMilestoneFn;
  updateMilestoneStatus: UpdateMilestoneStatusFn;
  pauseMilestone: PauseMilestoneFn;
  resumeMilestone: ResumeMilestoneFn;
  skipMilestone: SkipMilestoneFn;
  reorderMilestones: ReorderMilestonesFn;
  clearMilestones: ClearMilestonesFn;
  deleteGoal: DeleteGoalFn;
  recoverStaleGoalLanes: RecoverStaleGoalLanesFn;
  decomposeGoal: DecomposeGoalFn;
  planMilestoneSpec: PlanMilestoneSpecFn;
  advanceGoal: AdvanceGoalFn;
  progressOf: ProgressOfFn;
  isEnrolled: IsEnrolledFn;
  loadConfig: () => AshlrConfig;
}

let _core: GoalsCore | null | undefined = undefined;

async function importCore(): Promise<GoalsCore | null> {
  if (_core === undefined) {
    try {
      const [store, planner, advance, policy, config] = await Promise.all([
        import('../core/goals/store.js'),
        import('../core/goals/planner.js'),
        import('../core/goals/advance.js'),
        import('../core/sandbox/policy.js'),
        import('../core/config.js'),
      ]);
      _core = {
        createGoal: store.createGoal as CreateGoalFn,
        loadGoal: store.loadGoal as LoadGoalFn,
        listGoals: store.listGoals as ListGoalsFn,
        addMilestone: store.addMilestone as AddMilestoneFn,
        updateMilestoneStatus: store.updateMilestoneStatus as UpdateMilestoneStatusFn,
        pauseMilestone: store.pauseMilestone as PauseMilestoneFn,
        resumeMilestone: store.resumeMilestone as ResumeMilestoneFn,
        skipMilestone: store.skipMilestone as SkipMilestoneFn,
        reorderMilestones: store.reorderMilestones as ReorderMilestonesFn,
        clearMilestones: store.clearMilestones as ClearMilestonesFn,
        deleteGoal: store.deleteGoal as DeleteGoalFn,
        recoverStaleGoalLanes: store.recoverStaleGoalLanes as RecoverStaleGoalLanesFn,
        decomposeGoal: planner.decomposeGoal as DecomposeGoalFn,
        planMilestoneSpec: planner.planMilestoneSpec as PlanMilestoneSpecFn,
        advanceGoal: advance.advanceGoal as AdvanceGoalFn,
        progressOf: advance.progressOf as ProgressOfFn,
        isEnrolled: policy.isEnrolled as IsEnrolledFn,
        loadConfig: config.loadConfig as () => AshlrConfig,
      };
    } catch {
      _core = null;
    }
  }
  return _core ?? null;
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

type GoalsSub =
  | 'add'
  | 'list'
  | 'show'
  | 'plan'
  | 'advance'
  | 'status'
  | 'recover-stale'
  | 'pause'
  | 'resume'
  | 'skip'
  | 'reorder'
  | 'delete';

const SUBS: readonly GoalsSub[] = [
  'add',
  'list',
  'show',
  'plan',
  'advance',
  'status',
  'recover-stale',
  'pause',
  'resume',
  'skip',
  'reorder',
  'delete',
] as const;

interface ParsedGoalsArgs {
  sub: GoalsSub;
  /** Positional 1 — the objective (add) or goal id (show/plan/advance/pause/...). */
  arg1: string | undefined;
  /** Positional 2 — the milestone id (pause/resume/skip). */
  arg2: string | undefined;
  /** All positionals after the subcommand (reorder needs the full id list). */
  positionals: string[];
  /** --project <repo> for `add` (raw, un-resolved). */
  project: string | undefined;
  /** --max <n> milestone cap for `plan`. */
  max: number | undefined;
  json: boolean;
  allowCloud: boolean;
  /** --replace clears an already-planned goal's milestones before re-planning. */
  replace: boolean;
  /** --dry-run previews recover-stale without mutating goal records. */
  dryRun: boolean;
  help: boolean;
  error: string | undefined;
}

function parseGoalsArgs(args: string[]): ParsedGoalsArgs {
  const parsed: ParsedGoalsArgs = {
    sub: 'list',
    arg1: undefined,
    arg2: undefined,
    positionals: [],
    project: undefined,
    max: undefined,
    json: false,
    allowCloud: false,
    replace: false,
    dryRun: false,
    help: false,
    error: undefined,
  };

  if (args.length === 0) return parsed;

  const positionals: string[] = [];
  let i = 0;
  let subSeen = false;

  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--help' || a === '-h') {
      parsed.help = true;
    } else if (a === '--json') {
      parsed.json = true;
    } else if (a === '--allow-cloud') {
      parsed.allowCloud = true;
    } else if (a === '--replace') {
      parsed.replace = true;
    } else if (a === '--dry-run') {
      parsed.dryRun = true;
    } else if (a === '--project') {
      const val = args[++i];
      if (val === undefined) {
        parsed.error = '--project requires a repo path';
        return parsed;
      }
      parsed.project = val;
    } else if (a.startsWith('--project=')) {
      parsed.project = a.slice('--project='.length);
    } else if (a === '--max') {
      const r = parsePositiveInt('max', args[++i]);
      if ('error' in r) {
        parsed.error = r.error;
        return parsed;
      }
      parsed.max = r.n;
    } else if (a.startsWith('--max=')) {
      const r = parsePositiveInt('max', a.slice('--max='.length));
      if ('error' in r) {
        parsed.error = r.error;
        return parsed;
      }
      parsed.max = r.n;
    } else if (a.startsWith('-') && a !== '-') {
      parsed.error = `unknown flag: ${a}`;
      return parsed;
    } else if (!subSeen) {
      // First positional is the subcommand.
      if (!SUBS.includes(a as GoalsSub)) {
        parsed.error = `unknown subcommand: ${a}`;
        return parsed;
      }
      parsed.sub = a as GoalsSub;
      subSeen = true;
    } else {
      positionals.push(a);
    }
  }

  parsed.arg1 = positionals[0];
  parsed.arg2 = positionals[1];
  parsed.positionals = positionals;
  return parsed;
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const tty = isTty();
  const { bold, cyan, gray, dim } = makeColors(tty);
  const out = (s: string): void => {
    process.stdout.write(s + '\n');
  };

  out('');
  out(bold('  ashlr goals') + gray(' — plan, track, and steer high-level objectives'));
  out('');
  out(bold('  Usage'));
  out(`    ${cyan('ashlr goals add "<objective>"')} [--project <enrolled-repo>]`);
  out(`    ${cyan('ashlr goals list')} [--json]`);
  out(`    ${cyan('ashlr goals show <id>')} [--json]`);
  out(`    ${cyan('ashlr goals plan <id>')} [--allow-cloud] [--max <n>] [--replace]`);
  out(`    ${cyan('ashlr goals advance <id>')}`);
  out(`    ${cyan('ashlr goals status')} [--json]`);
  out(`    ${cyan('ashlr goals recover-stale')} [--dry-run] [--max <n>] [--json]`);
  out(`    ${cyan('ashlr goals pause <id>')} [milestone]`);
  out(`    ${cyan('ashlr goals resume <id>')} [milestone]`);
  out(`    ${cyan('ashlr goals skip <id> <milestone>')}`);
  out(`    ${cyan('ashlr goals reorder <id> <m1> <m2> ...')}`);
  out(`    ${cyan('ashlr goals delete <id>')}`);
  out('');
  out(bold('  Options'));
  const opts: [string, string][] = [
    ['--project <repo>', 'Bind a goal to an ENROLLED repo (required to advance).'],
    ['--max <n>', 'Cap how many milestones `plan` produces or stale lanes `recover-stale` resets.'],
    ['--allow-cloud', 'Allow a CLOUD model for optional plan refinement + spec authoring. Off by default.'],
    ['--replace', 'On `plan`, clear an already-planned goal’s milestones before re-planning.'],
    ['--dry-run', 'On `recover-stale`, preview eligible lanes without mutating goal records.'],
    ['--json', 'Machine-readable output on read paths (list/show/status).'],
    ['--help', 'Show this help.'],
  ];
  for (const [flag, desc] of opts) {
    out(`    ${cyan(pad(flag, 18))} ${desc}`);
  }
  out('');
  out(dim('  Planning is deterministic + local-only by default (no model, zero network).'));
  out(dim('  `advance` is SANDBOXED + PROPOSAL-ONLY: it produces a PENDING inbox proposal'));
  out(dim('  a human reviews with `ashlr inbox`. Nothing auto-applies; no real working'));
  out(dim('  tree is ever mutated, pushed, or deployed.'));
  out('');
}

// ─── Status glyphs ─────────────────────────────────────────────────────────────

function statusGlyph(s: MilestoneStatus): string {
  switch (s) {
    case 'done':
      return '✓';
    case 'proposed':
      return '◆';
    case 'in-progress':
      return '⟳';
    case 'blocked':
      return '✗';
    case 'paused':
      return '⏸';
    case 'skipped':
      return '⊘';
    default:
      return '·';
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * `ashlr goals <add|list|show|plan|advance|status|pause|resume|skip> ...`
 *
 * Default/`list`/`show`/`status`: read-only tracking over ~/.ashlr/goals +
 * swarm/inbox state. `add` creates a Goal (ENROLLMENT-checked --project). `plan`
 * decomposes + authors specs (deterministic; --allow-cloud opt-in). `advance`
 * runs the NEXT milestone through the sandboxed, proposal-only swarm path
 * (assertMayMutate-gated; produces a PENDING inbox proposal). pause/resume/skip
 * STEER the plan. Nothing auto-applies; no real working tree is ever mutated.
 *
 * Exit codes: 0 success, 1 runtime error / not-enrolled, 2 bad usage.
 */
export async function cmdGoals(args: string[]): Promise<number> {
  const parsed = parseGoalsArgs(args);
  const tty = isTty();
  const { red, green, yellow, bold, cyan, gray, dim } = makeColors(tty);
  const out = (s: string): void => {
    process.stdout.write(s + '\n');
  };

  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(red('error: ') + parsed.error + '\n');
    process.stderr.write('Run `ashlr goals --help` for usage.\n');
    return 2;
  }

  const core = await importCore();
  if (!core) {
    process.stderr.write(
      red('error: ') + 'goals command requires the M28 core (src/core/goals/*).\n',
    );
    return 1;
  }

  const cfg = core.loadConfig();

  // LOCAL-FIRST privacy warning for --allow-cloud (mirror ask.ts / reflect.ts).
  // Only meaningful on `plan` (the sole model-assisted path); printed to stderr
  // so --json stdout stays clean.
  if (parsed.allowCloud && parsed.sub === 'plan') {
    process.stderr.write(
      yellow('warning: ') +
        '--allow-cloud is set — objective + milestone text MAY be sent to a cloud model\n' +
        '         to refine the plan AND to author each milestone’s spec.\n' +
        '         Omit --allow-cloud to keep ALL planning + spec authoring deterministic +\n' +
        '         on-machine (default: zero non-localhost connections).\n',
    );
  }

  switch (parsed.sub) {
    // ─────────────────────────────────────────────────────────────────────
    case 'add': {
      const objective = parsed.arg1;
      if (!objective || objective.trim().length === 0) {
        process.stderr.write(red('error: ') + 'add requires an objective string.\n');
        return 2;
      }

      // ENROLLMENT-SCOPING (M25 lesson): resolve() + isEnrolled()-check --project
      // HERE before persisting. Core enforces it again on advance.
      let project: string | null = null;
      if (parsed.project !== undefined) {
        const abs = resolve(parsed.project);
        if (!core.isEnrolled(abs)) {
          process.stderr.write(
            red('error: ') +
              `repo not enrolled for autonomous work: ${abs}\n` +
              '         Enroll it first (e.g. `ashlr sandbox enroll <repo>`) before binding a goal.\n',
          );
          return 1;
        }
        project = abs;
      }

      const goal = core.createGoal(objective.trim(), { project });
      if (parsed.json) {
        out(JSON.stringify(goal, null, 2));
      } else {
        out(green('✓ ') + bold('created goal ') + cyan(goal.id));
        out(`  objective: ${goal.objective}`);
        out(`  project:   ${goal.project ?? gray('(none — planning only; cannot advance)')}`);
        out('');
        out(dim('  Next: `ashlr goals plan ' + goal.id + '` to decompose into milestones.'));
      }
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'list': {
      // READ-ONLY.
      const goals = core.listGoals();
      if (parsed.json) {
        out(JSON.stringify(goals, null, 2));
        return 0;
      }
      if (goals.length === 0) {
        out(gray('  No goals yet. Create one with `ashlr goals add "<objective>"`.'));
        return 0;
      }
      out('');
      out(bold('  Goals') + gray(` (${goals.length})`));
      out('');
      for (const g of goals) {
        const prog = core.progressOf(g);
        const pct = Math.round(prog.fractionDone * 100);
        out(
          `  ${cyan(pad(g.id, 28))} ${pad(g.status, 10)} ` +
            gray(`${prog.done}/${prog.total} done (${pct}%)`),
        );
        out(`  ${gray(pad('', 28))} ${dim(g.objective.slice(0, 60))}`);
      }
      out('');
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'show': {
      // READ-ONLY.
      const id = parsed.arg1;
      if (!id) {
        process.stderr.write(red('error: ') + 'show requires a goal id.\n');
        return 2;
      }
      const goal = core.loadGoal(id);
      if (!goal) {
        process.stderr.write(red('error: ') + `goal not found: ${id}\n`);
        return 1;
      }
      if (parsed.json) {
        out(JSON.stringify(goal, null, 2));
        return 0;
      }
      out('');
      out(bold('  ' + goal.objective));
      out(`  ${gray('id:')} ${cyan(goal.id)}   ${gray('status:')} ${goal.status}`);
      out(`  ${gray('project:')} ${goal.project ?? gray('(none)')}`);
      out('');
      if (goal.milestones.length === 0) {
        out(gray('  No milestones yet. Run `ashlr goals plan ' + goal.id + '`.'));
      } else {
        out(bold('  Milestones'));
        for (const m of goal.milestones) {
          out(
            `  ${statusGlyph(m.status)} ${cyan(pad(`#${m.order}`, 4))} ${pad(m.status, 12)} ${m.title}`,
          );
          const links: string[] = [];
          if (m.specId) links.push(`spec=${m.specId}`);
          if (m.swarmId) links.push(`swarm=${m.swarmId}`);
          if (m.proposalId) links.push(`proposal=${m.proposalId}`);
          if (links.length > 0) out(`      ${gray(links.join('  '))}`);
        }
      }
      out('');
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'plan': {
      const id = parsed.arg1;
      if (!id) {
        process.stderr.write(red('error: ') + 'plan requires a goal id.\n');
        return 2;
      }
      const goal = core.loadGoal(id);
      if (!goal) {
        process.stderr.write(red('error: ') + `goal not found: ${id}\n`);
        return 1;
      }

      // IDEMPOTENCY GUARD: `plan` appends milestones, so re-planning an already-
      // planned goal would DUPLICATE the entire set (corrupting order, progress
      // denominators, and nextActionableMilestone sequencing). Refuse unless the
      // user explicitly asks to --replace, which clears the existing milestones
      // first (a deliberate, destructive re-plan). Steering (reorder/skip/pause)
      // is the non-destructive way to adjust an existing plan.
      if (goal.milestones.length > 0 && !parsed.replace) {
        process.stderr.write(
          red('error: ') +
            `goal already planned (${goal.milestones.length} milestone(s)).\n` +
            '         Use `--replace` to clear + re-plan, or steer with ' +
            '`reorder`/`skip`/`pause`,\n' +
            '         or create a new goal.\n',
        );
        return 1;
      }
      if (goal.milestones.length > 0 && parsed.replace) {
        // --replace: clear the existing plan so we re-plan from a clean slate.
        core.clearMilestones(goal.id);
      }

      // DETERMINISTIC by default; --allow-cloud opens the local-first chain.
      const milestones = await core.decomposeGoal(goal.objective, cfg, {
        allowCloud: parsed.allowCloud,
        maxMilestones: parsed.max,
      });

      // Materialize milestones (bounded) then author + link a spec for each.
      let working = core.loadGoal(goal.id) ?? goal;
      const authored: { milestone: Milestone; specId: string | null }[] = [];
      for (const m of milestones) {
        const updated = core.addMilestone(working.id, { title: m.title, detail: m.detail });
        if (!updated) continue;
        working = updated;
        const newest = working.milestones[working.milestones.length - 1]!;
        let specId: string | null = null;
        try {
          // LOCAL-FIRST: thread the user's explicit --allow-cloud decision into
          // spec authoring. Default (no flag) is false => spec authoring can
          // NEVER reach a cloud provider on the default `goals plan` path, even
          // when a cloud provider sits in the configured providerChain.
          const spec = await core.planMilestoneSpec(working, newest, cfg, {
            allowCloud: parsed.allowCloud,
          });
          specId = spec.id;
          const linked = core.updateMilestoneStatus(working.id, newest.id, 'pending', {
            specId,
          });
          if (linked) working = linked;
        } catch {
          // Spec authoring is best-effort; the milestone still exists unplanned.
          specId = null;
        }
        authored.push({ milestone: newest, specId });
      }

      if (parsed.json) {
        out(JSON.stringify(core.loadGoal(working.id) ?? working, null, 2));
        return 0;
      }
      out(green('✓ ') + bold('planned ') + cyan(`${authored.length}`) + bold(' milestone(s)') +
        gray(` for ${working.id}`));
      for (const a of authored) {
        out(
          `  ${cyan(pad(`#${a.milestone.order}`, 4))} ${a.milestone.title}` +
            (a.specId ? gray(`  spec=${a.specId}`) : gray('  (spec deferred)')),
        );
      }
      out('');
      out(dim('  Next: `ashlr goals advance ' + working.id + '` to run the next milestone'));
      out(dim('        (sandboxed + proposal-only).'));
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'advance': {
      const id = parsed.arg1;
      if (!id) {
        process.stderr.write(red('error: ') + 'advance requires a goal id.\n');
        return 2;
      }
      const goal = core.loadGoal(id);
      if (!goal) {
        process.stderr.write(red('error: ') + `goal not found: ${id}\n`);
        return 1;
      }

      // ENROLLMENT-SCOPING (M25 lesson): re-check the goal's project HERE before
      // any core call that could start a swarm. Core (advanceGoal ->
      // assertMayMutate) enforces this AGAIN.
      if (!goal.project) {
        process.stderr.write(
          red('error: ') + 'goal has no enrolled project; cannot advance.\n' +
            '         Bind a goal to an enrolled repo with `--project` on `add`.\n',
        );
        return 1;
      }
      const repo = resolve(goal.project);
      if (!core.isEnrolled(repo)) {
        process.stderr.write(
          red('error: ') + `repo not enrolled for autonomous work: ${repo}\n`,
        );
        return 1;
      }

      let run: SwarmRun;
      try {
        // SANDBOXED + PROPOSAL-ONLY (core hardcodes sandbox+requireSandbox+propose).
        run = await core.advanceGoal(id, cfg, { allowCloud: parsed.allowCloud });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(red('error: ') + msg + '\n');
        return 1;
      }

      // Re-read the goal to surface the linked PENDING proposal id.
      const after = core.loadGoal(id);
      const advanced = after?.milestones.find((m) => m.swarmId === run.id);
      const proposalId = advanced?.proposalId ?? null;

      if (parsed.json) {
        out(
          JSON.stringify(
            { goalId: id, swarmId: run.id, status: run.status, proposalId },
            null,
            2,
          ),
        );
        return 0;
      }

      if (proposalId) {
        out(green('✓ ') + bold('advanced a milestone') + gray(` (swarm ${run.id}, ${run.status})`));
        out('');
        out('  A ' + bold('PENDING') + ' inbox proposal was produced — nothing was applied.');
        out(`  proposal: ${cyan(proposalId)}`);
        out('');
        out(dim('  Review and approve it (or not) with `ashlr inbox`.'));
        out(dim('  No real working tree was mutated, pushed, or deployed.'));
      } else {
        out(
          yellow('! ') +
            `advance ran (swarm ${run.id}, status ${run.status}) but produced no PENDING proposal.`,
        );
        out(dim('  The milestone is marked blocked for human attention. Inspect `ashlr swarm`.'));
        return 1;
      }
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'status': {
      // READ-ONLY tracking dashboard.
      const goals = core.listGoals();
      const rolled = goals.map((g) => ({ goal: g, progress: core.progressOf(g) }));
      if (parsed.json) {
        out(
          JSON.stringify(
            rolled.map((r) => r.progress),
            null,
            2,
          ),
        );
        return 0;
      }
      if (rolled.length === 0) {
        out(gray('  No goals to track yet.'));
        return 0;
      }
      out('');
      out(bold('  Goal tracking'));
      out('');
      for (const { goal, progress } of rolled) {
        const pct = Math.round(progress.fractionDone * 100);
        out(`  ${cyan(pad(goal.id, 28))} ${pad(goal.status, 10)} ${gray(`${pct}%`)}`);
        const segs: string[] = [];
        for (const [st, n] of Object.entries(progress.byStatus)) {
          segs.push(`${statusGlyph(st as MilestoneStatus)} ${st}:${n}`);
        }
        out(`  ${gray(pad('', 28))} ${dim(segs.join('  '))}`);
        if (progress.nextActionableId) {
          out(`  ${gray(pad('', 28))} ${dim('next: ' + progress.nextActionableId)}`);
        }
      }
      out('');
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'recover-stale': {
      const result = core.recoverStaleGoalLanes({
        limit: parsed.max,
        dryRun: parsed.dryRun,
      });
      if (parsed.json) {
        out(JSON.stringify(result, null, 2));
        return 0;
      }
      if (result.lanes.length === 0) {
        out(gray('  No stale proposal-less in-progress goal lanes found.'));
        return 0;
      }
      if (result.dryRun) {
        out(yellow('! ') + `would recover ${result.lanes.length}/${result.eligible} stale goal lane(s)`);
      } else {
        out(green('✓ ') + `recovered ${result.recovered}/${result.eligible} stale goal lane(s)`);
      }
      for (const lane of result.lanes) {
        out(
          `  ${cyan(lane.goalId)} ${dim(lane.milestoneId)} ` +
            gray(`${Math.round(lane.ageMs / 60000)}m stale`) +
            (lane.project ? gray(`  ${lane.project}`) : ''),
        );
      }
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'pause': {
      const id = parsed.arg1;
      if (!id) {
        process.stderr.write(red('error: ') + 'pause requires a goal id.\n');
        return 2;
      }
      const updated = core.pauseMilestone(id, parsed.arg2);
      if (!updated) {
        process.stderr.write(
          red('error: ') + `goal or milestone not found: ${id}${parsed.arg2 ? ` / ${parsed.arg2}` : ''}\n`,
        );
        return 1;
      }
      if (parsed.json) out(JSON.stringify(updated, null, 2));
      else out(green('✓ ') + (parsed.arg2 ? `paused milestone ${parsed.arg2}` : `paused goal ${id}`));
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'resume': {
      const id = parsed.arg1;
      if (!id) {
        process.stderr.write(red('error: ') + 'resume requires a goal id.\n');
        return 2;
      }
      const updated = core.resumeMilestone(id, parsed.arg2);
      if (!updated) {
        process.stderr.write(
          red('error: ') + `goal or milestone not found: ${id}${parsed.arg2 ? ` / ${parsed.arg2}` : ''}\n`,
        );
        return 1;
      }
      if (parsed.json) out(JSON.stringify(updated, null, 2));
      else out(green('✓ ') + (parsed.arg2 ? `resumed milestone ${parsed.arg2}` : `resumed goal ${id}`));
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'skip': {
      const id = parsed.arg1;
      const milestoneId = parsed.arg2;
      if (!id || !milestoneId) {
        process.stderr.write(red('error: ') + 'skip requires a goal id and a milestone id.\n');
        return 2;
      }
      const updated = core.skipMilestone(id, milestoneId);
      if (!updated) {
        process.stderr.write(red('error: ') + `goal or milestone not found: ${id} / ${milestoneId}\n`);
        return 1;
      }
      if (parsed.json) out(JSON.stringify(updated, null, 2));
      else out(green('✓ ') + `skipped milestone ${milestoneId}`);
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'reorder': {
      // STEERABLE: rewrite milestone order to the given id sequence. Pure local
      // edit (no swarm, no outward action). Any ids omitted keep their relative
      // order after the listed ones.
      const id = parsed.arg1;
      const orderedIds = parsed.positionals.slice(1);
      if (!id || orderedIds.length === 0) {
        process.stderr.write(
          red('error: ') + 'reorder requires a goal id and at least one milestone id.\n',
        );
        return 2;
      }
      const updated = core.reorderMilestones(id, orderedIds);
      if (!updated) {
        process.stderr.write(red('error: ') + `goal not found: ${id}\n`);
        return 1;
      }
      if (parsed.json) out(JSON.stringify(updated, null, 2));
      else {
        out(green('✓ ') + `reordered milestones for ${id}`);
        for (const m of updated.milestones) {
          out(`  ${cyan(pad(`#${m.order}`, 4))} ${m.title}`);
        }
      }
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    case 'delete': {
      // STEERABLE: remove a goal record entirely. Pure local FS delete under
      // ~/.ashlr/goals — never touches a user repo, never applies a proposal.
      const id = parsed.arg1;
      if (!id) {
        process.stderr.write(red('error: ') + 'delete requires a goal id.\n');
        return 2;
      }
      const goal = core.loadGoal(id);
      if (!goal) {
        process.stderr.write(red('error: ') + `goal not found: ${id}\n`);
        return 1;
      }
      core.deleteGoal(id);
      if (parsed.json) out(JSON.stringify({ deleted: id }, null, 2));
      else out(green('✓ ') + `deleted goal ${id}`);
      return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    default: {
      printHelp();
      return 2;
    }
  }
}
