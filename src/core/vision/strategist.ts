/**
 * M121: Strategist — the Elon/visionary-founder layer of the autonomous fleet.
 *
 * runStrategist() gathers current state (quality metrics + repo health +
 * recent goals + the current EndStateSpec), prompts a FRONTIER model with an
 * elite-company / first-principles / 10x-ambition persona, and returns a
 * StrategicBriefing that surfaces:
 *   - where the fleet actually stands vs. the north-star vision
 *   - the gap
 *   - proposed spec evolution
 *   - concrete recommended directions
 *   - new hard problems discovered
 *   - questions Mason needs to answer
 *   - proposed goals (fed to adoptBriefing → createGoal)
 *
 * adoptBriefing() applies the proposedEvolution to the spec AND creates goals
 * via the existing createGoal so the conductor pursues vision-aligned work.
 *
 * Never throws.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AshlrConfig } from '../types.js';
import { loadSpec, applyEvolution } from './spec.js';
import type { EndStateSpec } from './spec.js';
import { addDelta, curate, renderPlaybook } from './playbook.js';
import { computeQualityMetrics } from '../fleet/quality-metrics.js';
import { engineInstalled, buildEngineCommand, spawnEngine } from '../run/engines.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProposedGoal {
  objective: string;
  rationale: string;
  /** The spec priority title this goal serves (links goal → spec). */
  specPriority?: string;
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
    const { readdirSync, readFileSync } = require('node:fs');
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

const STRATEGIST_SYSTEM = `You are the visionary founder and chief strategy officer of an autonomous software-engineering company.

Your job is NOT to rubber-stamp progress — it is to raise the bar. You think in first principles. You look at where the system is, where it could be, and identify the single most important bottleneck between here and the end-state vision. As each bottleneck is solved, you immediately identify the next one.

Guiding principles you embody:
- 10x ambition: never accept "good enough"; always ask "what would this look like if it were 10x better?"
- First principles: ignore conventions, question assumptions, reason from fundamentals.
- Concrete over vague: every recommendation must be actionable by an engineering agent.
- Honest assessment: name the gap between current state and vision directly; don't soften it.
- Compounding progress: small wins compound — identify wins that unblock multiple downstream improvements.

You receive the current fleet state (quality metrics, health, goals progress) and the north-star EndStateSpec.
You must respond ONLY with valid JSON in exactly this shape (no prose, no markdown fences):

{
  "currentState": "<2-4 sentence honest assessment of where the fleet is today>",
  "gapToVision": "<2-4 sentence articulation of the most critical gap to close>",
  "proposedEvolution": {
    "northStar": "<updated north star or omit if unchanged>",
    "endState": "<updated end state or omit if unchanged>",
    "principles": ["<updated principles array or omit if unchanged>"],
    "priorities": [{"title": "...", "rationale": "...", "rank": 1}],
    "openProblems": ["<updated list or omit if unchanged>"],
    "ambitionLevel": <1-10 or omit if unchanged>
  },
  "recommendedDirection": ["<action 1>", "<action 2>", "<action 3>"],
  "newProblems": ["<newly identified hard problem>"],
  "questionsForMason": ["<question requiring Mason's direction>"],
  "proposedGoals": [
    {"objective": "<concrete goal objective>", "rationale": "<why this goal serves the vision>", "specPriority": "<priority title it serves>"}
  ]
}

proposedEvolution may omit any key that should remain unchanged.
proposedGoals should be 2–5 concrete, actionable goals an engineering agent can execute.
questionsForMason should surface genuine strategic forks — not implementation details.`;


// ---------------------------------------------------------------------------
// resolveStrategistClient — pick the best available model for vision briefings
// ---------------------------------------------------------------------------

const CLAUDE_DEFAULT_STRATEGIST_MODEL = 'claude-sonnet-4-5';

/**
 * Build a `complete(system, user)` function using the Claude Code CLI.
 * Mirrors buildClaudeCliComplete in manager.ts — duplicated minimally per
 * file-ownership rules (no shared util that touches both files).
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
      const result = spawnEngine(cmd, cfg, { timeoutMs: 300_000 });
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
 * Priority (controlled by cfg.foundry.managerJudgeEngine):
 *   1. 'auto' / 'claude' + claude allowed+installed → Claude CLI
 *   2. 'local' or claude unavailable → ollamaDirectComplete with the 72b model
 *
 * Returns { complete, judgeEngine }. Never throws.
 */
function resolveStrategistClient(
  cfg: AshlrConfig,
  ollamaBaseUrl: string,
  visionModel: string,
): { complete: (system: string, user: string) => Promise<string>; judgeEngine: string } {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  const managerJudgeEngine = (foundry?.['managerJudgeEngine'] as string | undefined) ?? 'auto';
  const allowedBackends: string[] = (foundry?.['allowedBackends'] as string[] | undefined) ?? ['builtin'];

  const wantClaude = managerJudgeEngine === 'auto' || managerJudgeEngine === 'claude';
  const claudeAllowed = allowedBackends.includes('claude');

  if (wantClaude && claudeAllowed && engineInstalled('claude', cfg)) {
    const isClaudeModel = visionModel.startsWith('claude') || visionModel.includes('claude');
    const claudeModel = isClaudeModel ? visionModel : CLAUDE_DEFAULT_STRATEGIST_MODEL;
    return {
      complete: buildClaudeCliCompleteStrategist(cfg, claudeModel),
      judgeEngine: claudeModel,
    };
  }

  return {
    complete: (system: string, user: string) =>
      ollamaDirectComplete(ollamaBaseUrl, visionModel, system, user, 2048, 0.3),
    judgeEngine: visionModel,
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
}

async function gatherFleetState(project?: string | null): Promise<FleetState> {
  const metrics = computeQualityMetrics('30d', project ? { repo: project } : undefined);

  let activeGoalCount = 0;
  let completedGoalCount = 0;
  try {
    const { listGoals } = await import('../goals/store.js');
    const active = listGoals({ status: 'active' });
    const done = listGoals({ status: 'done' });
    activeGoalCount = active.length;
    completedGoalCount = done.length;
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

  return { metrics, activeGoalCount, completedGoalCount, repoHealthSummary };
}

function buildStatePrompt(state: FleetState, spec: EndStateSpec, playbookContext?: string): string {
  const m = state.metrics;
  return `=== CURRENT FLEET STATE (30-day window) ===
Proposals created: ${m.proposalsCreated}
Merged: ${m.merged} | Rejected: ${m.rejected} | Pending: ${m.pending}
Accept rate: ${(m.acceptRate * 100).toFixed(1)}%
Empty-diff rate: ${(m.emptyRate * 100).toFixed(1)}%
Trivial ratio: ${(m.trivialRatio * 100).toFixed(1)}%
Avg diff lines: ${m.avgDiffLines.toFixed(0)}
Active goals: ${state.activeGoalCount} | Completed goals: ${state.completedGoalCount}
Repo health: ${state.repoHealthSummary}

=== NORTH-STAR SPEC (v${spec.version}) ===
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
Assess the gap between current state and the north-star vision. Raise the ambition. Identify the single most critical bottleneck to close next. Propose concrete goals the engineering fleet can execute immediately.${playbookContext ? `\n\n${playbookContext}` : ''}`;
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
    goals.push({
      objective,
      rationale: typeof obj['rationale'] === 'string' ? obj['rationale'] : '',
      specPriority: typeof obj['specPriority'] === 'string' ? obj['specPriority'] : undefined,
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

    // ── Gather state ────────────────────────────────────────────────────────
    const state = await gatherFleetState(project);

    // ── Resolve frontier client ─────────────────────────────────────────────
    // M135: Claude CLI FIRST when managerJudgeEngine='auto'/'claude' + claude allowed+installed.
    // Mirrors the manager.ts fix — getActiveClient was always returning a client (local 72b
    // fallback), preventing the Claude CLI path from ever being reached.
    const visionModel = ((cfg.foundry as Record<string, unknown> | undefined)?.['managerJudgeModel'] as string | undefined) || 'qwen2.5:72b-instruct-q4_K_M';
    const ollamaBase = (cfg.models as Record<string, unknown> | undefined)?.['ollama'] as string | undefined;
    const ollamaBaseUrl = (ollamaBase ?? 'http://localhost:11434').replace(/\/+$/, '') + '/v1';

    // Step 1: resolveStrategistClient — Claude CLI when allowed+installed, else local-72b.
    let complete: ((system: string, user: string) => Promise<string>) | null = null;
    let strategistJudgeEngine = visionModel;
    {
      const resolved = resolveStrategistClient(cfg, ollamaBaseUrl, visionModel);
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
    const userPrompt = buildStatePrompt(state, spec, playbookCtx);
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
  opts: { by?: 'mason' | 'strategist' } = {},
): Promise<{ specId: string; goalIds: string[] }> {
  const by = opts.by ?? 'strategist';
  const project = briefing.project;
  const specId = project ? project.replace(/[^a-z0-9._-]/gi, '-').toLowerCase() : 'ecosystem';

  try {
    // ── 1. Evolve the spec ─────────────────────────────────────────────────
    const acePlaybook = (cfg.foundry as Record<string, unknown> | undefined)?.['acePlaybook'] === true;
    const hasEvolution = Object.keys(briefing.proposedEvolution).length > 0;
    if (hasEvolution) {
      applyEvolution(
        specId,
        briefing.proposedEvolution,
        by,
        `Strategist briefing from ${briefing.generatedAt}: ${briefing.recommendedDirection[0] ?? 'vision update'}`,
      );
    }

    // ── 1b. ACE Playbook: append deltas (no collapse) ──────────────────
    if (acePlaybook) {
      for (const direction of briefing.recommendedDirection) {
        if (direction.trim()) addDelta('strategy', direction);
      }
      for (const problem of briefing.newProblems) {
        if (problem.trim()) addDelta('strategy', `Hard problem: ${problem}`);
      }
      curate('strategy');
    }

    // ── 2. Create goals from proposedGoals ────────────────────────────────
    const goalIds: string[] = [];
    if (briefing.proposedGoals.length > 0) {
      const { createGoal } = await import('../goals/store.js');
      for (const pg of briefing.proposedGoals) {
        // Encode spec priority linkage in the objective prefix so existing
        // goal store schema is not changed (backward-compatible).
        const objective = pg.specPriority
          ? `[vision:${pg.specPriority}] ${pg.objective}`
          : pg.objective;
        const goal = createGoal(objective, {
          project: project ?? undefined,
          cfg,
        });
        goalIds.push(goal.id);
      }
    }

    return { specId, goalIds };
  } catch {
    return { specId, goalIds: [] };
  }
}
