/**
 * M121/M162/M179: Strategist — the ECOSYSTEM MANAGER of the autonomous fleet.
 *
 * M162 upgrades:
 *  - Runs on cfg.foundry.strategistModel (default: 'claude-opus-4-8') — the
 *    most capable model available. Founder-grade strategy needs best reasoning.
 *  - North-star = HUMAN LEVERAGE: optimises for substantive autonomous
 *    merges/week + engineering-hours saved, NOT proposal volume.
 *  - ELON-MODE system prompt: maximally bold, contrarian, first-principles.
 *    10x bets > 10% tweaks. Identifies THE single bottleneck + the ONE
 *    highest-leverage move. Ruthless kill-list. Aggressive + fast correction.
 *  - Rich context wiring: imports gatherStrategicContext from context.js
 *    (best-effort, tolerates absence) to feed repo health / recent commits /
 *    open issues / outcomes into the strategist's input.
 *  - Goal focus discipline: briefing enforces "finish ONE goal end-to-end
 *    before new ones" + prunes stale/failing goals.
 *  - ACE playbook: reads + writes the M149 playbook so judgment compounds.
 *
 * M179 upgrades — ECOSYSTEM MANAGER:
 *  - Feeds gatherStrategicContext's full per-repo data (not just narrative)
 *    so the strategist sees each enrolled tool's state individually.
 *  - System prompt upgraded to ECOSYSTEM MANAGER: assesses EACH tool from
 *    first principles, sets 10x-ambitious per-tool goals and next milestones.
 *  - ProposedGoal gains targetRepo field — goals are scoped to a specific tool
 *    (e.g. 'ashlr-pulse') or null for ecosystem-wide.
 *  - proposedEvolution gains toolRoadmap (ToolRoadmapEntry[]) — one entry per
 *    enrolled tool with ambitionLevel, vision, and nextMilestone.
 *  - Per-tool prompt section injected into buildStatePrompt so the model
 *    reasons about each tool individually, not just fleet-aggregate metrics.
 *
 * runStrategist() gathers current state, loads the EndStateSpec, computes the
 * north-star leverage metric, prompts the elite model, and returns a
 * StrategicBriefing.
 *
 * adoptBriefing() applies proposedEvolution to the spec AND creates goals via
 * createGoal so the conductor pursues vision-aligned work.
 *
 * Never throws.
 */

import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AshlrConfig, Goal } from '../types.js';
import { defaultStrategistModel } from '../run/model-catalog.js';
import { loadSpec, applyEvolution } from './spec.js';
import type { EndStateSpec, ToolRoadmapEntry } from './spec.js';
import { addDelta, curate, renderPlaybook } from './playbook.js';
import { computeQualityMetrics } from '../fleet/quality-metrics.js';
import { engineInstalled, buildEngineCommand, spawnEngine } from '../run/engines.js';
import { computeNorthStar, northStarSummary } from './north-star.js';
import { ecosystemSummary } from '../ecosystem/map.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProposedGoal {
  objective: string;
  rationale: string;
  /** The spec priority title this goal serves (links goal → spec). */
  specPriority?: string;
  /**
   * M179: The target repo/tool this goal applies to (e.g. 'ashlr-pulse').
   * null = ecosystem-wide goal not scoped to a single tool.
   */
  targetRepo?: string | null;
}

export interface StrategicBriefing {
  generatedAt: string;
  project: string | null;
  /** Concise assessment of where the fleet is today. */
  currentState: string;
  /** Articulation of the gap between current state and the north-star vision. */
  gapToVision: string;
  /** Proposed mutations to the EndStateSpec (may be empty if no evolution needed). */
  proposedEvolution: Partial<Omit<EndStateSpec, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'history'>>;
  /** Concrete directions the fleet should pursue next (ordered by priority). */
  recommendedDirection: string[];
  /** Newly identified hard problems not yet in the spec. */
  newProblems: string[];
  /** Questions that require Mason's input before the fleet can proceed. */
  questionsForMason: string[];
  /** Goals to create so the conductor pursues vision-aligned work. */
  proposedGoals: ProposedGoal[];
}

/** The strategist contract permits at most three new goals per briefing. */
export const MAX_STRATEGIST_GOALS_PER_BRIEFING = 3;

export type BriefingGoalAdoptionSkipReason =
  | 'briefing-goal-cap'
  | 'goal-focus-cap'
  | 'goal-source-degraded'
  | 'duplicate-existing-goal'
  | 'goal-id-collision'
  | 'target-not-enrolled'
  | 'target-ambiguous'
  | 'target-invalid';

export interface BriefingGoalAdoptionEntry {
  index: number;
  objective: string;
  targetRepo: string | null;
  project: string | null;
  disposition: 'create' | 'skip';
  reason: 'ready' | BriefingGoalAdoptionSkipReason;
}

export interface BriefingAdoptionPreview {
  briefingGeneratedAt: string;
  goalSourceState: 'missing' | 'healthy' | 'degraded';
  activeThreshold: number;
  openGoalCount: number;
  availableSlots: number;
  proposedCount: number;
  createCount: number;
  skippedCount: number;
  entries: BriefingGoalAdoptionEntry[];
}

export type BriefingGoalAdoptionOutcomeReason =
  | BriefingGoalAdoptionSkipReason
  | 'persisted'
  | 'goal-store-write-failed'
  | 'adoption-failed';

export interface BriefingGoalAdoptionOutcome {
  index: number;
  objective: string;
  targetRepo: string | null;
  project: string | null;
  outcome: 'created' | 'failed' | 'skipped';
  reason: BriefingGoalAdoptionOutcomeReason;
  goalId?: string;
}

export interface AdoptBriefingResult {
  specId: string;
  specOutcome: 'not-requested' | 'persisted' | 'failed';
  goalIds: string[];
  createdCount: number;
  failedCount: number;
  skippedCount: number;
  outcomes: BriefingGoalAdoptionOutcome[];
  preview: BriefingAdoptionPreview;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function briefingsDir(): string {
  return join(homedir(), '.ashlr', 'vision', 'briefings');
}

function writeBriefing(briefing: StrategicBriefing): void {
  try {
    const dir = briefingsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = briefing.generatedAt.replace(/[:.]/g, '-');
    const project = briefing.project ? `-${briefing.project}` : '';
    const file = join(dir, `${ts}${project}.json`);
    writeFileSync(file, JSON.stringify(briefing, null, 2) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

/** Load the most recent briefing, or null. Never throws. */
export function loadLatestBriefing(project?: string | null): StrategicBriefing | null {
  try {
    const dir = briefingsDir();
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f: string) => f.endsWith('.json'))
      .sort()
      .reverse();
    for (const f of files) {
      try {
        const raw = readFileSync(join(dir, f), 'utf8');
        const parsed = JSON.parse(raw) as StrategicBriefing;
        if (project !== undefined && parsed.project !== (project ?? null)) continue;
        return parsed;
      } catch { /* skip */ }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// System persona
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Direct Ollama call with long timeout (mirrors manager.ts — DO NOT import from there)
// ---------------------------------------------------------------------------

async function ollamaDirectComplete(
  baseUrl: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000); // 3 min
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

const STRATEGIST_RETRY_SUFFIX = `\n\nYour previous response could not be parsed as JSON. Respond with ONLY the JSON object matching the schema above and nothing else — no prose, no markdown.`;

/**
 * M162/M179: ELON-MODE ECOSYSTEM MANAGER system prompt.
 *
 * M179 upgrades: the strategist is no longer just a fleet-metrics analyst —
 * it is the ECOSYSTEM MANAGER responsible for the whole ashlr ecosystem:
 * ashlr-hub + 8 enrolled tool repos. It assesses each tool individually,
 * sets ambitious per-tool goals, and produces a per-tool roadmap.
 *
 * Bold, contrarian, first-principles. 10x bets. One bottleneck. Kill-list.
 * Per-tool vision. Ruthless prioritisation toward the leverage north-star.
 */
const STRATEGIST_SYSTEM = `You are the CEO, chief engineer, and ECOSYSTEM MANAGER of an autonomous AI software company — the most ambitious engineering project of your life.

You manage the ENTIRE ashlr ecosystem: the core fleet (ashlr-hub) AND the full portfolio of enrolled tool repos that make the ecosystem useful to developers worldwide.

You are NOT a consultant producing balanced analysis. You are a founder who:
- THINKS IN FIRST PRINCIPLES: strip away every assumption, rebuild from physics. Why does this system exist? What is it actually trying to do? What would someone build if they started from scratch tomorrow?
- DEMANDS 10x NOT 10%: a 10% improvement is a distraction. If a goal is worth pursuing, it should be worth pursuing at 10x. If it's not, kill it.
- IDENTIFIES THE SINGLE BOTTLENECK: the system has exactly ONE constraint that matters right now. Everything else is noise. Name it explicitly and call it "THE BOTTLENECK".
- PROPOSES THE ONE MOVE: given the bottleneck, there is ONE highest-leverage action that unblocks the most downstream value. Name it explicitly as "THE MOVE".
- MAINTAINS A KILL-LIST: the most dangerous thing is misallocated effort. What should stop immediately? What is consuming resources without delivering real leverage? Be ruthless.
- MAKES AGGRESSIVE CALLS: don't hedge. Pick a direction. If you're wrong, you'll correct fast. Paralysis via analysis is the enemy.
- OPTIMISES FOR HUMAN LEVERAGE: the north star is NOT proposal volume or lines of code — it is substantive autonomous merges per week and engineering hours freed for Mason to focus on direction. Every recommendation must move this needle.
- ENFORCES FOCUS DISCIPLINE: finish ONE goal end-to-end before starting new ones. Prune stale, failing, or low-leverage goals aggressively. A fleet with 10 open goals ships nothing.
- MANAGES THE ECOSYSTEM: for each enrolled tool repo, assess its current state from first principles — what does it actually do, what is genuinely broken or missing, what ONE change would make it 10x more valuable?

THE NORTH STAR METRIC: "substantive autonomous merges/week + engineering hours saved"
If the fleet is producing lots of proposals but few are merging, something is broken. If the fleet is merging trivial one-liners, the quality bar is wrong. The only stat that matters is: how many hours per week is Mason NOT having to think about routine engineering?

THE ECOSYSTEM LENS: You receive per-repo state for every enrolled tool. For EACH tool:
1. Understand what it does (from its name + recent commits).
2. Assess its current state honestly (health, activity, open issues).
3. Identify — first-principles, 10x-ambitious — the ONE thing that would make it genuinely great and more useful.
4. Propose a concrete next milestone (specific enough for an engineering agent to execute).

TOOL ASSESSMENT ANCHORS (use these as starting points, adapt to actual repo state):
- ashlr-pulse: the observability layer. Is the dashboard real-time? Does it have fleet-command round-trip? What would make it indispensable?
- phantom-secrets: secret management. Is team-vault sync hardened? E2E encrypted? What would make it production-grade for teams?
- ashlr-plugin: the token-efficiency MCP layer. Is the genome loop tight? Is the savings signal actionable? What would make it a must-have for every Claude user?
- binshield: binary/dep security. Is the scan comprehensive? Is it integrated into the merge gate? What would make it a hard security requirement?
- ashlrcode: the code agent. Is it leveraging the genome? Is it genuinely faster/cheaper than raw Claude? What would make it the default choice?
- ashlr-workbench: the local dev environment. Is it reproducible? Is it fast? What would make it the gold standard for AI-assisted dev?
- stack: the project scaffolding / template engine. Is it opinionated enough? Does it compose with the fleet? What would make it the fastest way to start a new project?

THE BRIEFING STRUCTURE you must follow (in the JSON response):
1. currentState: Ground truth — what is the fleet + ecosystem actually doing today? Cite numbers. Don't spin them.
2. THE BOTTLENECK: (encode in gapToVision) The single root cause holding back the leverage metric across the WHOLE ecosystem. One bottleneck. Not three.
3. THE MOVE: (encode as recommendedDirection[0]) The ONE highest-leverage action to take next. Specific enough that an engineering agent can execute it.
4. KILL-LIST: (encode in recommendedDirection[1..2]) What to stop doing. What to prune. What is waste.
5. proposedGoals: ≤3 goals, ruthlessly prioritised. Each MUST be tagged with a targetRepo (the tool it applies to) or null for ecosystem-wide. Goals must be SUBSTANTIVE per-tool features/improvements — not fleet-internal metrics.
6. proposedEvolution: Raise ambition if current spec is too timid. Include toolRoadmap with one entry per enrolled tool.

You receive: fleet metrics, north-star leverage data, active goals, spec, per-repo state for EVERY enrolled tool, and accumulated strategy lessons.
You must respond ONLY with valid JSON in exactly this shape (no prose, no markdown fences):

{
  "currentState": "<2-4 sentence HONEST assessment — cite numbers — no spin>",
  "gapToVision": "<THE BOTTLENECK: the single root-cause constraint holding back leverage across the whole ecosystem>",
  "proposedEvolution": {
    "northStar": "<updated north star or omit if unchanged>",
    "endState": "<updated end state or omit if unchanged>",
    "principles": ["<updated principles array or omit if unchanged>"],
    "priorities": [{"title": "...", "rationale": "...", "rank": 1}],
    "openProblems": ["<updated list or omit if unchanged>"],
    "ambitionLevel": <1-10 or omit if unchanged>,
    "toolRoadmap": [
      {"repo": "<tool-name>", "ambitionLevel": <1-10>, "vision": "<10x vision for this tool>", "nextMilestone": "<specific next milestone>"}
    ]
  },
  "recommendedDirection": [
    "<THE MOVE — the ONE highest-leverage action to unblock the bottleneck>",
    "<KILL-LIST item 1 — what to stop doing>",
    "<KILL-LIST item 2 — what to prune or cut>"
  ],
  "newProblems": ["<newly identified hard problem not yet in the spec>"],
  "questionsForMason": ["<genuine strategic fork requiring Mason's direction — not implementation details>"],
  "proposedGoals": [
    {"objective": "<specific, executable per-tool goal>", "rationale": "<why this makes the tool genuinely great + increases ecosystem leverage>", "specPriority": "<priority title it serves>", "targetRepo": "<tool-name or null for ecosystem-wide>"}
  ]
}

proposedEvolution may omit any key that should remain unchanged.
proposedGoals MUST be ≤3. Fewer is better. Each must be a SUBSTANTIVE per-tool feature/improvement (not fleet-internal metrics). Tag each with targetRepo.
proposedEvolution.toolRoadmap should cover every enrolled tool you have data for.
questionsForMason: only ask when a strategic fork GENUINELY requires Mason's judgment.`;


// ---------------------------------------------------------------------------
// resolveStrategistClient — pick the best available model for vision briefings
// ---------------------------------------------------------------------------

/**
 * M162: Default strategist model — the most capable Claude model available.
 * Founder-grade strategy requires the best reasoning. Overridden by
 * cfg.foundry.strategistModel.
 */
// M320: strategist default resolves via defaultStrategistModel() in
// run/model-catalog.ts (Fable 5 when claude5.fable is on, else Opus 4.8).

/**
 * Build a `complete(system, user)` function using the Claude Code CLI.
 * Mirrors buildClaudeCliComplete in manager.ts — duplicated minimally per
 * file-ownership rules (no shared util that touches both files).
 *
 * M162: passes the elite strategist model explicitly via --model so Opus 4.8
 * (or cfg.foundry.strategistModel) is always used, not the CLI default.
 */
function buildClaudeCliCompleteStrategist(
  cfg: AshlrConfig,
  model: string,
): (system: string, user: string) => Promise<string> {
  return async (system: string, user: string): Promise<string> => {
    try {
      const combined = `${system}\n\n${user}`;
      const cmd = buildEngineCommand('claude', combined, cfg, { model });
      if (!cmd) return '';
      const result = await spawnEngine(cmd, cfg, { timeoutMs: 300_000 });
      if (!result.ok || !result.output) return '';
      try {
        const parsed = JSON.parse(result.output) as Record<string, unknown>;
        const text = parsed['result'];
        return typeof text === 'string' ? text : result.output;
      } catch {
        return result.output;
      }
    } catch {
      return '';
    }
  };
}

/**
 * Resolve the best available client for strategic briefings.
 *
 * M162/M320: model priority — cfg.foundry.strategistModel → defaultStrategistModel(cfg)
 * (Fable 5 when claude5.fable is on, else 'claude-opus-4-8'). Founder-grade
 * strategy always uses the elite model.
 *
 * Engine priority (controlled by cfg.foundry.managerJudgeEngine):
 *   1. 'auto' / 'claude' + claude allowed+installed → Claude CLI (with elite model)
 *   2. 'local' or claude unavailable → ollamaDirectComplete with the local model
 *
 * Returns { complete, judgeEngine }. Never throws.
 */
function resolveStrategistClient(
  cfg: AshlrConfig,
  ollamaBaseUrl: string,
  localFallbackModel: string,
): { complete: (system: string, user: string) => Promise<string>; judgeEngine: string } {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  const managerJudgeEngine = (foundry?.['managerJudgeEngine'] as string | undefined) ?? 'auto';
  const allowedBackends: string[] = (foundry?.['allowedBackends'] as string[] | undefined) ?? ['builtin'];

  // M162: read strategistModel from cfg — override the default elite model.
  const configuredModel = (foundry?.['strategistModel'] as string | undefined);
  const eliteModel = configuredModel ?? defaultStrategistModel(cfg);

  const wantClaude = managerJudgeEngine === 'auto' || managerJudgeEngine === 'claude';
  const claudeAllowed = allowedBackends.includes('claude');

  if (wantClaude && claudeAllowed && engineInstalled('claude', cfg)) {
    // Always use the elite model for strategic briefings — ignore whether
    // eliteModel starts with 'claude'; the explicit --model flag is always set.
    const primary = buildClaudeCliCompleteStrategist(cfg, eliteModel);
    // M337 (review fix): the claude5.fable contract promises an automatic
    // Opus 4.8 fallback for the STRATEGIST too — without it, accounts
    // lacking Fable access silently produced empty briefings. Mirror the
    // judge wrapper: retry once on Opus when a Fable call yields nothing.
    if (eliteModel !== 'claude-fable-5') {
      return { complete: primary, judgeEngine: eliteModel };
    }
    const fallback = buildClaudeCliCompleteStrategist(cfg, 'claude-opus-4-8');
    return {
      complete: async (system: string, user: string): Promise<string> =>
        (await primary(system, user)) || fallback(system, user),
      judgeEngine: eliteModel,
    };
  }

  return {
    complete: (system: string, user: string) =>
      ollamaDirectComplete(ollamaBaseUrl, localFallbackModel, system, user, 2048, 0.3),
    judgeEngine: localFallbackModel,
  };
}

// ---------------------------------------------------------------------------
// State gathering
// ---------------------------------------------------------------------------

interface FleetState {
  metrics: ReturnType<typeof computeQualityMetrics>;
  activeGoalCount: number;
  completedGoalCount: number;
  repoHealthSummary: string;
  /** M162: active goal titles for focus-discipline enforcement. */
  activeGoalTitles?: string[];
  /** M162: rich context narrative from gatherStrategicContext (best-effort). */
  richContext?: string;
  /**
   * M179: full per-repo context array from gatherStrategicContext.
   * Used to build the per-tool assessment section of the ecosystem prompt.
   */
  repoContexts?: Array<{
    name: string;
    health: string;
    hasTests: boolean;
    recentCommits: string[];
    openIssueCount: number | null;
    lastActivity: string | null;
  }>;
}

async function gatherFleetState(cfg: AshlrConfig, project?: string | null): Promise<FleetState> {
  const metrics = computeQualityMetrics('30d', project ? { repo: project } : undefined);

  let activeGoalCount = 0;
  let completedGoalCount = 0;
  let activeGoalTitles: string[] = [];
  try {
    const { listGoals } = await import('../goals/store.js');
    const active = listGoals({ status: 'active' });
    const done = listGoals({ status: 'done' });
    activeGoalCount = active.length;
    completedGoalCount = done.length;
    // M162: capture goal titles for focus-discipline section in briefing.
    activeGoalTitles = (active as Array<{ objective?: string }>)
      .map((g) => g.objective ?? '')
      .filter(Boolean)
      .slice(0, 10);
  } catch { /* best-effort */ }

  let repoHealthSummary = 'Health data unavailable.';
  try {
    const { computeReport } = await import('../quality/health.js');
    const report = await computeReport();
    const repos = (report as unknown as { repos?: Array<{ overall: number }> }).repos ?? [];
    const repoCount = repos.length;
    const avgScore = repoCount > 0
      ? Math.round(repos.reduce((s, r) => s + r.overall, 0) / repoCount)
      : 0;
    repoHealthSummary = `${repoCount} repos scored; avg health ${avgScore}/100.`;
  } catch { /* best-effort */ }

  // M162/M179: best-effort rich context from gatherStrategicContext (sibling module).
  // Returns StrategicContext { narrative, repos, outcomes, fleet } — we inject
  // the narrative string AND the full repos array into the briefing prompt.
  // M179: captures repoContexts for per-tool ecosystem assessment. Tolerates absence.
  let richContext: string | undefined;
  let repoContexts: FleetState['repoContexts'];
  try {
    const contextMod = await import('./context.js') as {
      gatherStrategicContext?: (cfg?: Partial<AshlrConfig>) => Promise<{
        narrative: string;
        repos: Array<{
          name: string;
          health: string;
          hasTests: boolean;
          recentCommits: string[];
          openIssueCount: number | null;
          lastActivity: string | null;
        }>;
      }>;
    };
    if (typeof contextMod.gatherStrategicContext === 'function') {
      const ctx = await contextMod.gatherStrategicContext(cfg);
      richContext = ctx.narrative;
      // M179: capture per-repo data for ecosystem-manager per-tool prompt section.
      if (Array.isArray(ctx.repos) && ctx.repos.length > 0) {
        repoContexts = ctx.repos;
      }
    }
  } catch { /* context module absent or errored — degrade gracefully */ }

  return { metrics, activeGoalCount, completedGoalCount, repoHealthSummary, activeGoalTitles, richContext, repoContexts };
}

function buildStatePrompt(
  state: FleetState,
  spec: EndStateSpec,
  northStarCtx: string,
  playbookContext?: string,
): string {
  const m = state.metrics;

  // M162: goal-focus discipline section — surfaces open goals so the strategist
  // can enforce "finish ONE goal before new ones" and prune stale/failing goals.
  const goalFocusSection = state.activeGoalTitles && state.activeGoalTitles.length > 0
    ? `\n=== ACTIVE GOALS (${state.activeGoalTitles.length} open — focus discipline applies) ===
RULE: Finish ONE goal end-to-end before proposing new ones.
RULE: Prune goals that are stale, low-leverage, or failing.
Current open goals:
${state.activeGoalTitles.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`
    : '\n=== ACTIVE GOALS ===\nNo active goals — the fleet has a clean slate.';

  // M162: rich context narrative from gatherStrategicContext (best-effort).
  const richCtxSection = state.richContext
    ? `\n=== RICH REPO CONTEXT ===\n${state.richContext}`
    : '';

  // M179: per-tool ecosystem assessment section — one block per enrolled repo.
  // Gives the Ecosystem Manager detailed state to reason about each tool.
  let perToolSection = '';
  if (state.repoContexts && state.repoContexts.length > 0) {
    const toolLines: string[] = [
      `\n=== PER-TOOL ECOSYSTEM STATE (${state.repoContexts.length} enrolled repos) ===`,
      'For each tool: assess current state, identify what would make it 10x more valuable, set an ambitious next milestone.',
    ];
    for (const repo of state.repoContexts) {
      const health = repo.health === 'clean' ? 'clean' : repo.health === 'dirty' ? 'dirty (uncommitted changes)' : 'no-git';
      const tests = repo.hasTests ? 'has tests' : 'NO TESTS';
      const issues = repo.openIssueCount === null ? 'gh unavailable' : `${repo.openIssueCount} open issues`;
      const lastDate = repo.lastActivity ? repo.lastActivity.slice(0, 10) : 'unknown';
      const lastCommit = repo.recentCommits[0] ?? '(no recent commits)';
      const recentWork = repo.recentCommits.slice(0, 3).join(' | ') || '(no commits)';
      toolLines.push(
        `  TOOL: ${repo.name}`,
        `    State: ${health} | ${tests} | ${issues} | last active: ${lastDate}`,
        `    Recent work: ${recentWork}`,
        `    Last commit: "${lastCommit}"`,
      );
    }
    perToolSection = toolLines.join('\n');
  }

  // M184: inject ecosystem summary so the strategist reasons compositionally
  // across the 13-repo platform — prefer A×B compositions over isolated per-tool features.
  const ecosystemCtxRaw = ecosystemSummary();
  const ecosystemCtxSection = ecosystemCtxRaw
    ? `
${ecosystemCtxRaw}

=== COMPOSITION DIRECTIVE ===
You have the full ecosystem map above. When proposing goals, recommendedDirection, and toolRoadmap entries, PREFER COMPOSITIONAL MOVES over isolated per-tool features. The highest-leverage ideas are A×B: e.g. phantom→fleet-auth, binshield→merge-gate, pulse→fleet-telemetry, ashlrcode→executor-backend, core-efficiency→fleet-token-cost. Reference specific repos from the map in your proposals.`
    : '';

  return `${northStarCtx}

=== FLEET METRICS (30-day window) ===
Proposals created: ${m.proposalsCreated}
Positive merge/acceptance credit: unavailable pending authenticated post-merge release
Rejected: ${m.rejected} | Pending: ${m.pending}
Empty-diff rate: ${(m.emptyRate * 100).toFixed(1)}%
Trivial ratio: ${(m.trivialRatio * 100).toFixed(1)}%
Avg diff lines: ${m.avgDiffLines.toFixed(0)}
Completed goals: ${state.completedGoalCount}
Repo health: ${state.repoHealthSummary}
${goalFocusSection}${richCtxSection}${perToolSection}${ecosystemCtxSection}

=== VISION SPEC (v${spec.version}) ===
North star: ${spec.northStar}

End state: ${spec.endState}

Principles:
${spec.principles.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}

Current priorities (ranked):
${spec.priorities
  .sort((a, b) => a.rank - b.rank)
  .map((p) => `  ${p.rank}. ${p.title} — ${p.rationale}`)
  .join('\n')}

Open problems:
${spec.openProblems.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}

Ambition level: ${spec.ambitionLevel}/10
Last updated: ${spec.updatedAt} (by ${spec.updatedBy})

=== YOUR TASK ===
Identify THE BOTTLENECK. Name THE MOVE. Build the KILL-LIST. Propose ≤3 goals that directly increase substantive autonomous merges/week. Raise ambition if the spec is too timid. Enforce focus discipline on the active goals list above.${playbookContext ? `\n\n${playbookContext}` : ''}`;
}

// ---------------------------------------------------------------------------
// JSON extraction (mirrors manager.ts)
// ---------------------------------------------------------------------------

function extractJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fall through */ }

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  // Find the LAST {...} block (models sometimes emit preamble JSON then the real one).
  const allBraceMatches = [...raw.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*/g)];
  for (let i = allBraceMatches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(allBraceMatches[i]![0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  // Greedy: find the outermost balanced {...} block.
  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch { /* fall through */ }
    }
  }

  return null;
}

function parseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function parseProposedGoals(v: unknown): ProposedGoal[] {
  if (!Array.isArray(v)) return [];
  const goals: ProposedGoal[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const objective = typeof obj['objective'] === 'string' ? obj['objective'] : '';
    if (!objective) continue;
    const rawTargetRepo = obj['targetRepo'];
    const targetRepo: string | null | undefined =
      typeof rawTargetRepo === 'string' ? rawTargetRepo :
      rawTargetRepo === null ? null :
      undefined;
    goals.push({
      objective,
      rationale: typeof obj['rationale'] === 'string' ? obj['rationale'] : '',
      specPriority: typeof obj['specPriority'] === 'string' ? obj['specPriority'] : undefined,
      targetRepo,
    });
  }
  return goals;
}

function parsePriorities(v: unknown): EndStateSpec['priorities'] {
  if (!Array.isArray(v)) return [];
  const out: EndStateSpec['priorities'] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    out.push({
      title: typeof obj['title'] === 'string' ? obj['title'] : 'Unknown',
      rationale: typeof obj['rationale'] === 'string' ? obj['rationale'] : '',
      rank: typeof obj['rank'] === 'number' ? obj['rank'] : out.length + 1,
    });
  }
  return out;
}

function parseBriefingFromJson(
  obj: Record<string, unknown>,
  project: string | null,
  generatedAt: string,
): StrategicBriefing {
  const evolution = (typeof obj['proposedEvolution'] === 'object' && obj['proposedEvolution'] !== null)
    ? obj['proposedEvolution'] as Record<string, unknown>
    : {};

  const proposedEvolution: StrategicBriefing['proposedEvolution'] = {};
  if (typeof evolution['northStar'] === 'string') proposedEvolution.northStar = evolution['northStar'];
  if (typeof evolution['endState'] === 'string') proposedEvolution.endState = evolution['endState'];
  if (Array.isArray(evolution['principles'])) proposedEvolution.principles = parseStringArray(evolution['principles']);
  if (Array.isArray(evolution['priorities'])) proposedEvolution.priorities = parsePriorities(evolution['priorities']);
  if (Array.isArray(evolution['openProblems'])) proposedEvolution.openProblems = parseStringArray(evolution['openProblems']);
  if (typeof evolution['ambitionLevel'] === 'number') proposedEvolution.ambitionLevel = Math.max(1, Math.min(10, Math.round(evolution['ambitionLevel'])));
  // M179: parse toolRoadmap entries from proposedEvolution.
  if (Array.isArray(evolution['toolRoadmap'])) {
    const roadmap: ToolRoadmapEntry[] = [];
    for (const item of evolution['toolRoadmap']) {
      if (typeof item !== 'object' || item === null) continue;
      const r = item as Record<string, unknown>;
      if (typeof r['repo'] !== 'string' || !r['repo']) continue;
      roadmap.push({
        repo: r['repo'] as string,
        ambitionLevel: typeof r['ambitionLevel'] === 'number' ? Math.max(1, Math.min(10, Math.round(r['ambitionLevel']))) : 5,
        vision: typeof r['vision'] === 'string' ? r['vision'] : '',
        nextMilestone: typeof r['nextMilestone'] === 'string' ? r['nextMilestone'] : '',
      });
    }
    if (roadmap.length > 0) proposedEvolution.toolRoadmap = roadmap;
  }

  return {
    generatedAt,
    project,
    currentState: typeof obj['currentState'] === 'string' ? obj['currentState'] : 'State assessment unavailable.',
    gapToVision: typeof obj['gapToVision'] === 'string' ? obj['gapToVision'] : 'Gap analysis unavailable.',
    proposedEvolution,
    recommendedDirection: parseStringArray(obj['recommendedDirection']),
    newProblems: parseStringArray(obj['newProblems']),
    questionsForMason: parseStringArray(obj['questionsForMason']),
    proposedGoals: parseProposedGoals(obj['proposedGoals']),
  };
}

// ---------------------------------------------------------------------------
// Minimal client wrapper (mirrors manager.ts wrapClient)
// ---------------------------------------------------------------------------

interface MinimalClient {
  complete?: (system: string, user: string) => Promise<string>;
  chat?: (messages: Array<{ role: string; content: string }>) => Promise<{ content: string }>;
  completions?: { create: (opts: Record<string, unknown>) => Promise<{ choices: Array<{ message: { content: string } }> }> };
  model?: string;
}

function wrapClient(
  raw: MinimalClient,
): ((system: string, user: string) => Promise<string>) | null {
  if (typeof raw.complete === 'function') {
    return raw.complete.bind(raw);
  }
  if (raw.completions && typeof (raw.completions as Record<string, unknown>)['create'] === 'function') {
    const completions = raw.completions;
    return async (system: string, user: string): Promise<string> => {
      const resp = await completions.create({
        model: raw.model ?? 'gpt-4',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 2048,
        temperature: 0.3,
      });
      return resp.choices[0]?.message?.content ?? '';
    };
  }
  if (typeof raw.chat === 'function') {
    const chat = raw.chat.bind(raw);
    return async (system: string, user: string): Promise<string> => {
      const resp = await chat([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);
      return resp.content;
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public: runStrategist()
// ---------------------------------------------------------------------------

/**
 * Run the visionary strategist agent.
 *
 * Gathers fleet state, loads (or bootstraps) the EndStateSpec, prompts a
 * frontier model with the 10x-ambition persona, parses the response into a
 * StrategicBriefing, persists it, and returns it.
 *
 * Never throws — degrades to a zeroed briefing on any error.
 */
export async function runStrategist(
  cfg: AshlrConfig,
  opts: { project?: string | null } = {},
): Promise<StrategicBriefing> {
  const project = opts.project ?? null;
  const generatedAt = new Date().toISOString();

  const fallback = (): StrategicBriefing => ({
    generatedAt,
    project,
    currentState: 'State assessment unavailable — strategist could not run.',
    gapToVision: 'Gap analysis unavailable.',
    proposedEvolution: {},
    recommendedDirection: [],
    newProblems: [],
    questionsForMason: [],
    proposedGoals: [],
  });

  try {
    // ── Load spec ───────────────────────────────────────────────────────────
    const specId = project ? project.replace(/[^a-z0-9._-]/gi, '-').toLowerCase() : 'ecosystem';
    const spec = loadSpec(specId) ?? loadSpec('ecosystem');
    if (!spec) return fallback();

    // ── Gather state + north-star metric ────────────────────────────────────
    const state = await gatherFleetState(cfg, project);

    // M162: compute the leverage north-star metric — always best-effort.
    const northStarMetric = computeNorthStar(cfg);
    const northStarCtx = northStarSummary(northStarMetric);

    // ── Resolve frontier client ─────────────────────────────────────────────
    // M162: strategistModel from cfg.foundry.strategistModel → elite Opus 4.8.
    // M135: Claude CLI FIRST when managerJudgeEngine='auto'/'claude' + claude allowed+installed.
    const foundryRaw = cfg.foundry as Record<string, unknown> | undefined;
    // localFallbackModel: used only when Claude CLI is unavailable.
    const localFallbackModel = (foundryRaw?.['managerJudgeModel'] as string | undefined) || 'qwen2.5:72b-instruct-q4_K_M';
    const visionModel = localFallbackModel; // kept for getActiveClient fallback path
    const ollamaBase = (cfg.models as Record<string, unknown> | undefined)?.['ollama'] as string | undefined;
    const ollamaBaseUrl = (ollamaBase ?? 'http://localhost:11434').replace(/\/+$/, '') + '/v1';

    // Step 1: resolveStrategistClient — Claude CLI (elite model) when allowed+installed, else local.
    let complete: ((system: string, user: string) => Promise<string>) | null = null;
    let strategistJudgeEngine = localFallbackModel;
    {
      const resolved = resolveStrategistClient(cfg, ollamaBaseUrl, localFallbackModel);
      complete = resolved.complete;
      strategistJudgeEngine = resolved.judgeEngine;
    }

    // Step 2: if resolved to local (not claude), try getActiveClient — handles test mocks
    // (m121 mocks getActiveClient to return a deterministic client) and cloud API keys.
    const resolvedIsClaude = strategistJudgeEngine.startsWith('claude') || strategistJudgeEngine.includes('claude');
    if (!resolvedIsClaude) {
      try {
        const { getActiveClient } = await import('../run/provider-client.js');
        const raw = await getActiveClient(cfg, { allowCloud: true, model: visionModel }) as MinimalClient;
        const wrapped = wrapClient(raw);
        if (wrapped) {
          complete = wrapped;
          strategistJudgeEngine = (raw as { model?: string }).model ?? 'cloud';
        }
      } catch { /* keep resolveStrategistClient result */ }
    }

    void strategistJudgeEngine; // available for future briefing metadata

    // ── Prompt ──────────────────────────────────────────────────────────────
    const acePlaybook = (cfg.foundry as Record<string, unknown> | undefined)?.['acePlaybook'] === true;
    const playbookCtx = acePlaybook ? renderPlaybook('strategy', 400) : undefined;
    const userPrompt = buildStatePrompt(state, spec, northStarCtx, playbookCtx);
    let raw: string;
    try {
      raw = await complete(STRATEGIST_SYSTEM, userPrompt);
    } catch {
      return fallback();
    }

    // ── Parse (with one-shot retry on failure) ───────────────────────────────
    let obj = extractJson(raw);
    if (!obj) {
      try {
        const retryPrompt = userPrompt + STRATEGIST_RETRY_SUFFIX;
        const raw2 = await complete(STRATEGIST_SYSTEM, retryPrompt);
        obj = extractJson(raw2);
      } catch { /* retry failed — fall through */ }
    }
    const briefing = obj
      ? parseBriefingFromJson(obj, project, generatedAt)
      : fallback();

    writeBriefing(briefing);
    return briefing;
  } catch {
    return fallback();
  }
}

// ---------------------------------------------------------------------------
// Public: adoptBriefing()
// ---------------------------------------------------------------------------

export interface BriefingAdoptionPreviewOptions {
  enrolledRepos: readonly string[];
  existingGoals: readonly Goal[];
  activeThreshold: number;
  goalSourceState?: 'missing' | 'healthy' | 'degraded';
}

type TargetResolution =
  | { project: string | null; reason: 'ready' }
  | { project: null; reason: Extract<BriefingGoalAdoptionSkipReason,
    'target-not-enrolled' | 'target-ambiguous' | 'target-invalid'> };

function goalObjective(pg: ProposedGoal): string {
  return pg.specPriority
    ? `[vision:${pg.specPriority}] ${pg.objective}`
    : pg.objective;
}

function normalizedGoalIdentity(objective: string, project: string | null): string {
  const normalizedObjective = objective
    .replace(/^\s*\[vision:[^\]]+\]\s*/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return `${project ?? '<ecosystem>'}\0${normalizedObjective}`;
}

function resolveBriefingGoalTarget(
  pg: ProposedGoal,
  briefingProject: string | null,
  enrolledRepos: readonly string[],
): TargetResolution {
  // Missing targetRepo is the legacy single-project briefing shape. An
  // explicit null remains an ecosystem-wide, planning-only goal.
  const requested = pg.targetRepo === undefined ? briefingProject : pg.targetRepo;
  if (requested === null) return { project: null, reason: 'ready' };
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    return { project: null, reason: 'target-invalid' };
  }

  const target = requested.trim();
  if (isAbsolute(target)) {
    const exact = enrolledRepos.filter((repo) => repo === target);
    if (exact.length === 1) return { project: exact[0]!, reason: 'ready' };
    return { project: null, reason: 'target-not-enrolled' };
  }

  // Model briefings use tool names (for example "ashlr-pulse"). Resolve only
  // an exact basename match. Fuzzy/prefix matching would silently broaden the
  // repo authority selected by a human-approved briefing.
  if (target.includes('/') || target.includes('\\')) {
    return { project: null, reason: 'target-invalid' };
  }
  const matches = enrolledRepos.filter((repo) => basename(repo) === target);
  if (matches.length === 1) return { project: matches[0]!, reason: 'ready' };
  if (matches.length > 1) return { project: null, reason: 'target-ambiguous' };
  return { project: null, reason: 'target-not-enrolled' };
}

/**
 * Compile a strategist briefing into a deterministic, bounded goal-adoption
 * preview. This is pure over the supplied snapshots: it writes no goal/spec,
 * runs no agent, and grants no execution or merge authority.
 */
export function previewBriefingAdoption(
  briefing: StrategicBriefing,
  opts: BriefingAdoptionPreviewOptions,
): BriefingAdoptionPreview {
  const enrolledRepos = [...new Set(opts.enrolledRepos)].sort();
  const goalSourceState = opts.goalSourceState ?? 'healthy';
  const activeThreshold = Number.isFinite(opts.activeThreshold)
    ? Math.max(1, Math.floor(opts.activeThreshold))
    : 1;
  const openGoals = opts.existingGoals.filter(
    (goal) => goal.status === 'active' || goal.status === 'planning',
  );
  const enrolledSet = new Set(enrolledRepos);
  // Match goal-focus policy: only goals bound to currently enrolled roots
  // consume autonomous-focus capacity. Unbound or unenrolled legacy goals are
  // still included in duplicate detection so repeated approval cannot clone
  // their planning records.
  const focusGoals = openGoals.filter(
    (goal) => goal.project !== null && enrolledSet.has(goal.project),
  );
  const availableSlots = Math.max(0, activeThreshold - focusGoals.length);
  // Goal ids are deterministically derived from the raw objective, without
  // project or status. Reserve every persisted raw objective so adopting a
  // briefing cannot overwrite archived/done history or collide across repos.
  const claimedObjectives = new Set(opts.existingGoals.map((goal) => goal.objective));
  const identities = new Set(
    opts.existingGoals.map((goal) => normalizedGoalIdentity(goal.objective, goal.project)),
  );
  const entries: BriefingGoalAdoptionEntry[] = [];
  let planned = 0;

  for (let index = 0; index < briefing.proposedGoals.length; index++) {
    const pg = briefing.proposedGoals[index]!;
    const objective = goalObjective(pg);
    const targetRepo = pg.targetRepo === undefined ? briefing.project : pg.targetRepo;
    const target = resolveBriefingGoalTarget(pg, briefing.project, enrolledRepos);
    const base = {
      index,
      objective,
      targetRepo: targetRepo ?? null,
      project: target.project,
    };

    // Dedupe and focus decisions require a complete goal inventory. A missing
    // directory is authoritative empty; malformed, truncated, unreadable, or
    // bounded inventories are degraded and must not create new work.
    if (goalSourceState === 'degraded') {
      entries.push({ ...base, disposition: 'skip', reason: 'goal-source-degraded' });
      continue;
    }
    if (index >= MAX_STRATEGIST_GOALS_PER_BRIEFING) {
      entries.push({ ...base, disposition: 'skip', reason: 'briefing-goal-cap' });
      continue;
    }
    if (target.reason !== 'ready') {
      entries.push({ ...base, disposition: 'skip', reason: target.reason });
      continue;
    }

    if (claimedObjectives.has(objective)) {
      entries.push({ ...base, disposition: 'skip', reason: 'goal-id-collision' });
      continue;
    }
    const identity = normalizedGoalIdentity(objective, target.project);
    if (identities.has(identity)) {
      entries.push({ ...base, disposition: 'skip', reason: 'duplicate-existing-goal' });
      continue;
    }
    if (planned >= availableSlots) {
      entries.push({ ...base, disposition: 'skip', reason: 'goal-focus-cap' });
      continue;
    }

    claimedObjectives.add(objective);
    identities.add(identity);
    planned += 1;
    entries.push({ ...base, disposition: 'create', reason: 'ready' });
  }

  return {
    briefingGeneratedAt: briefing.generatedAt,
    goalSourceState,
    activeThreshold,
    openGoalCount: focusGoals.length,
    availableSlots,
    proposedCount: briefing.proposedGoals.length,
    createCount: planned,
    skippedCount: entries.length - planned,
    entries,
  };
}

/**
 * Apply a StrategicBriefing to the fleet:
 *   1. Evolve the EndStateSpec with proposedEvolution (updatedBy:'strategist').
 *   2. Create goals from proposedGoals via createGoal, tagging each with the
 *      spec priority it serves (encoded as a prefix in the objective so the
 *      conductor's existing goal store works as-is without schema changes).
 *
 * Returns the updated spec and the created goal ids.
 * Never throws.
 */
export async function adoptBriefing(
  cfg: AshlrConfig,
  briefing: StrategicBriefing,
  opts: {
    by?: 'mason' | 'strategist';
    /** Hermetic snapshot seams; production callers omit these. */
    enrolledRepos?: readonly string[];
    existingGoals?: readonly Goal[];
    goalSourceState?: 'missing' | 'healthy' | 'degraded';
    activeThreshold?: number;
  } = {},
): Promise<AdoptBriefingResult> {
  const by = opts.by ?? 'strategist';
  const project = briefing.project;
  const specId = project ? project.replace(/[^a-z0-9._-]/gi, '-').toLowerCase() : 'ecosystem';
  const emptyPreview = (): BriefingAdoptionPreview => ({
    briefingGeneratedAt: briefing.generatedAt,
    goalSourceState: 'degraded',
    activeThreshold: Math.max(1, Math.floor(opts.activeThreshold ?? 4)),
    openGoalCount: 0,
    availableSlots: 0,
    proposedCount: briefing.proposedGoals.length,
    createCount: 0,
    skippedCount: 0,
    entries: [],
  });

  // Spec persistence is independent of the optional goal-adoption
  // infrastructure. A missing policy or goal store must never suppress an
  // otherwise valid spec evolution.
  const hasEvolution = Object.keys(briefing.proposedEvolution).length > 0;
  let specOutcome: AdoptBriefingResult['specOutcome'] = 'not-requested';
  if (hasEvolution) {
    try {
      const evolved = applyEvolution(
        specId,
        briefing.proposedEvolution,
        by,
        `Strategist briefing from ${briefing.generatedAt}: ${briefing.recommendedDirection[0] ?? 'vision update'}`,
      );
      const persisted = loadSpec(specId);
      specOutcome = persisted !== null && JSON.stringify(persisted) === JSON.stringify(evolved)
        ? 'persisted'
        : 'failed';
    } catch {
      specOutcome = 'failed';
    }
  }

  // ACE playbook deltas are likewise independent, best-effort local learning.
  // Preserve their established never-throw behavior even when goal adoption is
  // unavailable or fail-closed.
  const acePlaybook = (cfg.foundry as Record<string, unknown> | undefined)?.['acePlaybook'] === true;
  if (acePlaybook) {
    try {
      for (const direction of briefing.recommendedDirection) {
        if (direction.trim()) addDelta('strategy', direction);
      }
      for (const problem of briefing.newProblems) {
        if (problem.trim()) addDelta('strategy', `Hard problem: ${problem}`);
      }
      curate('strategy');
    } catch {
      // Best-effort local playbook behavior remains isolated from spec/goals.
    }
  }

  if (briefing.proposedGoals.length === 0) {
    return {
      specId,
      specOutcome,
      goalIds: [],
      createdCount: 0,
      failedCount: 0,
      skippedCount: 0,
      outcomes: [],
      preview: emptyPreview(),
    };
  }

  try {
    const { createGoal, listGoalsDetailed, loadGoal } = await import('../goals/store.js');
    const { goalFocusActiveThreshold } = await import('../goals/focus.js');
    const enrolledRepos = opts.enrolledRepos ?? (await import('../sandbox/policy.js')).listEnrolled();
    const goalInventory = opts.existingGoals !== undefined
      ? {
          goals: opts.existingGoals,
          sourceState: opts.goalSourceState ?? 'healthy' as const,
        }
      : listGoalsDetailed();
    const preview = previewBriefingAdoption(briefing, {
      enrolledRepos,
      existingGoals: goalInventory.goals,
      goalSourceState: goalInventory.sourceState,
      activeThreshold: opts.activeThreshold ?? goalFocusActiveThreshold(cfg),
    });

    // Create goals only after an authoritative inventory and target preview.
    const outcomes: BriefingGoalAdoptionOutcome[] = [];
    for (const entry of preview.entries) {
      const base = {
        index: entry.index,
        objective: entry.objective,
        targetRepo: entry.targetRepo,
        project: entry.project,
      };
      if (entry.disposition !== 'create') {
        outcomes.push({
          ...base,
          outcome: 'skipped',
          reason: entry.reason as BriefingGoalAdoptionSkipReason,
        });
        continue;
      }
      try {
        const goal = createGoal(entry.objective, {
          project: entry.project,
          cfg,
        });
        const persisted = loadGoal(goal.id);
        if (
          persisted !== null &&
          persisted.id === goal.id &&
          persisted.objective === entry.objective &&
          persisted.project === entry.project &&
          persisted.createdAt === goal.createdAt &&
          persisted.updatedAt === goal.updatedAt
        ) {
          outcomes.push({ ...base, outcome: 'created', reason: 'persisted', goalId: goal.id });
        } else {
          outcomes.push({ ...base, outcome: 'failed', reason: 'goal-store-write-failed' });
        }
      } catch {
        outcomes.push({ ...base, outcome: 'failed', reason: 'goal-store-write-failed' });
      }
    }

    const goalIds = outcomes.flatMap((outcome) =>
      outcome.outcome === 'created' && outcome.goalId !== undefined ? [outcome.goalId] : [],
    );
    return {
      specId,
      specOutcome,
      goalIds,
      createdCount: goalIds.length,
      failedCount: outcomes.filter((outcome) => outcome.outcome === 'failed').length,
      skippedCount: outcomes.filter((outcome) => outcome.outcome === 'skipped').length,
      outcomes,
      preview,
    };
  } catch {
    const outcomes: BriefingGoalAdoptionOutcome[] = briefing.proposedGoals.map((pg, index) => ({
      index,
      objective: goalObjective(pg),
      targetRepo: pg.targetRepo === undefined ? briefing.project : pg.targetRepo,
      project: null,
      outcome: 'failed',
      reason: 'adoption-failed',
    }));
    return {
      specId,
      specOutcome,
      goalIds: [],
      createdCount: 0,
      failedCount: outcomes.length,
      skippedCount: 0,
      outcomes,
      preview: emptyPreview(),
    };
  }
}
