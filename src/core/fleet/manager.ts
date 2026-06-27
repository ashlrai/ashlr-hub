/**
 * M120: Fleet Manager / CEO agent — frontier-model oversight layer.
 *
 * Judges pending proposals on quality (value/correctness/scope/alignment) and
 * produces a ManagerReport scorecard. SHADOW MODE by default: records judgements
 * in the decisions ledger and optionally rejects noise/harmful, but NEVER merges.
 *
 * Key design rules:
 *   - Never throws (runManager wraps everything).
 *   - On LLM parse failure: default to verdict 'review' — never auto-reject on
 *     uncertainty.
 *   - wouldMerge is advisory only (does not trigger any apply).
 *   - applyRejects=false (default): pure shadow — no setStatus calls.
 *   - applyRejects=true: setStatus(id,'rejected',...) only for noise/harmful.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AshlrConfig, Proposal, QualityMetrics } from '../types.js';
import { recordDecision } from './decisions-ledger.js';
import { recordJudgeTrace } from './judge-trace.js';
import { computeQualityMetrics } from './quality-metrics.js';
import { engineInstalled, buildEngineCommand, spawnEngine } from '../run/engines.js';

// ---------------------------------------------------------------------------
// Public types (defined here — not in types.ts per file ownership rules)
// ---------------------------------------------------------------------------

/** Per-proposal verdict produced by the frontier judge. */
export interface ManagerVerdict {
  proposalId: string;
  /** ship = high value + low risk; review = needs human look; noise = trivial/spam; harmful = dangerous. */
  verdict: 'ship' | 'review' | 'noise' | 'harmful';
  /** Overall value of the change (1-5). */
  value: number;
  /** Correctness confidence (1-5). */
  correctness: number;
  /** Scope/blast-radius score (1=tiny … 5=huge). */
  scope: number;
  /** Alignment with repo purpose (1-5). */
  alignment: number;
  /** One-line rationale from the judge. */
  rationale: string;
  /**
   * Advisory: would this be safe to auto-merge?
   * True only when: verdict==='ship' AND risk==='low' AND scope is small
   * (≤4 files, ≤150 diff lines). NEVER true for noise/harmful. Never triggers
   * any actual merge — purely informational.
   */
  wouldMerge: boolean;
}

/** Full oversight report produced by runManager. */
export interface ManagerReport {
  /** ISO timestamp. */
  generatedAt: string;
  /** Window used for quality metrics. */
  window: string;
  /** Aggregated quality metrics over the window. */
  metrics: QualityMetrics;
  /** One verdict per judged proposal. */
  verdicts: ManagerVerdict[];
  /** Proposal ids/titles that scored 'ship'. */
  wins: string[];
  /** Patterns observed in noise/harmful proposals (1 string per concern). */
  concerns: string[];
  /** Concrete tuning recommendations for the fleet operator. */
  recommendations: string[];
  /** Narrative paragraph synthesising the fleet health. */
  narrative: string;
  /** Model id used as the judge (e.g. 'claude-opus-4-5' or 'local'). */
  judgeEngine: string;
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/** Count changed lines in a unified diff (+/- lines, excluding +++ / ---). */
function countDiffLines(diff: string | undefined): number {
  if (!diff) return 0;
  let n = 0;
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))) {
      n++;
    }
  }
  return n;
}

/** Count rough file count from diff headers (`--- a/...` or `+++ b/...`). */
function countDiffFiles(diff: string | undefined): number {
  if (!diff) return 0;
  const set = new Set<string>();
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
      set.add(line.slice(6));
    }
  }
  return set.size;
}

/** Truncate diff to ~6KB for the judge prompt. */
function truncateDiff(diff: string | undefined): string {
  if (!diff) return '(no diff)';
  const MAX = 6144;
  if (diff.length <= MAX) return diff;
  const head = diff.slice(0, MAX);
  return head + '\n... [diff truncated]';
}

// ---------------------------------------------------------------------------
// LLM prompt + parse
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = `You are a code-proposal judge for an autonomous engineering fleet.
Evaluate the proposal using structured chain-of-thought reasoning, then emit the final verdict JSON.

## Required output format

First, write your step-by-step assessment using this exact structure:
<reasoning>
VALUE: [1-5] — [one sentence: how much does this improve the codebase?]
CORRECTNESS: [1-5] — [one sentence: how confident are you the change is correct?]
SCOPE: [1-5] — [one sentence: blast radius — how many files/systems touched?]
ALIGNMENT: [1-5] — [one sentence: does this match the repo purpose or north-star?]
VERDICT: [ship|review|noise|harmful] — [one sentence: why this verdict?]
RATIONALE: [one sentence summary for the rationale field]
</reasoning>

Then, on a NEW line immediately after </reasoning>, emit ONLY this JSON — no other text after it:
{"value":3,"correctness":3,"scope":3,"alignment":3,"verdict":"review","rationale":"one sentence"}

## Field definitions
  value       1-5  how much does this improve the codebase? (1=trivial, 5=critical)
  correctness 1-5  how confident are you the change is correct? (1=suspicious, 5=clearly correct)
  scope       1-5  blast radius (1=single line, 5=touches many files / risky)
  alignment   1-5  does this match the repo purpose or stated north-star? (5=directly advances it, 1=unrelated)
  verdict     one of: ship | review | noise | harmful
              ship=value≥4 AND correctness≥4 AND no obvious risk
              review=uncertain or needs human look
              noise=trivial/no diff/spam
              harmful=dangerous/destructive/security risk
              When in doubt choose review. Never choose noise or harmful speculatively.
  rationale   one sentence explaining your verdict

## Example output
<reasoning>
VALUE: 4 — Fixes a null-check that prevents a crash in production.
CORRECTNESS: 5 — The guard is correctly placed and the logic is sound.
SCOPE: 1 — Single line change in one file, no blast radius.
ALIGNMENT: 4 — Directly improves reliability, aligned with north-star.
VERDICT: ship — High value, high correctness, minimal scope.
RATIONALE: Small null-check prevents crash with no blast radius.
</reasoning>
{"value":4,"correctness":5,"scope":1,"alignment":4,"verdict":"ship","rationale":"Small null-check prevents crash with no blast radius."}`;
const JUDGE_RETRY_SUFFIX = `\n\nYour previous response could not be parsed as JSON. Respond with ONLY the JSON object and nothing else. Example: {"value":3,"correctness":3,"scope":3,"alignment":3,"verdict":"review","rationale":"needs inspection"}`;

/**
 * Load the EndStateSpec for a proposal's repo (best-effort — never throws).
 * Returns null when no spec is found or the vision module is unavailable.
 */
async function loadSpecForProposal(repo: string | undefined): Promise<{ northStar: string; priorities: string } | null> {
  if (!repo) return null;
  try {
    const { loadSpec } = await import('../vision/spec.js');
    // Try repo-derived id first, then global ecosystem spec.
    const repoId = repo.replace(/[^a-z0-9._-]/gi, '-').toLowerCase();
    const spec = loadSpec(repoId) ?? loadSpec('ecosystem');
    if (!spec) return null;
    const priorities = spec.priorities
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 3)
      .map((p) => `  ${p.rank}. ${p.title}`)
      .join('\n');
    return { northStar: spec.northStar, priorities };
  } catch {
    return null;
  }
}

function buildJudgePrompt(proposal: Proposal, specCtx?: { northStar: string; priorities: string } | null): string {
  const visionSection = specCtx
    ? `\nNorth-Star Vision: ${specCtx.northStar}\nTop Priorities:\n${specCtx.priorities}\n`
    : '';
  return `Proposal to judge:

Title: ${proposal.title}
Summary: ${proposal.summary}
Kind: ${proposal.kind}
Engine: ${proposal.engineModel ?? 'unknown'}${visionSection}
Diff:
${truncateDiff(proposal.diff)}`;
}

/** Attempt to extract JSON from a potentially prose-wrapped LLM response. */

/**
 * Extract the chain-of-thought reasoning block that precedes the verdict JSON.
 * Looks for text inside <reasoning>...</reasoning> tags; falls back to any
 * prose that appears before the first "{" in the response.
 * Returns empty string when no reasoning is found.
 */
function extractFullReasoning(raw: string): string {
  // Primary: <reasoning>...</reasoning> block
  const tagMatch = raw.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
  if (tagMatch?.[1]) return tagMatch[1].trim();

  // Fallback: prose before the first JSON brace
  const braceIdx = raw.indexOf('{');
  if (braceIdx > 0) {
    const prose = raw.slice(0, braceIdx).trim();
    if (prose.length > 0) return prose;
  }

  return '';
}

function extractJson(raw: string): Record<string, unknown> | null {
  // Try direct parse first.
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fall through */ }

  // Strip markdown fences.
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

const VALID_VERDICTS = new Set(['ship', 'review', 'noise', 'harmful']);

/** Normalise synonym verdicts a local model might emit. */
function normaliseVerdict(raw: string): ManagerVerdict['verdict'] {
  const v = raw.toLowerCase().trim();
  if (v === 'ship' || v === 'approve' || v === 'approved' || v === 'merge' || v === 'lgtm') return 'ship';
  if (v === 'noise' || v === 'trivial' || v === 'skip' || v === 'ignore') return 'noise';
  if (v === 'harmful' || v === 'dangerous' || v === 'reject' || v === 'rejected' || v === 'block') return 'harmful';
  return 'review';
}

function clamp(n: unknown, lo: number, hi: number): number {
  const num = typeof n === 'number' ? n : Number(n);
  if (!isFinite(num)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(num)));
}

/**
 * Call the frontier model and parse its verdict.
 * On any parse/network failure returns a safe 'review' verdict.
 */
export async function judgeProposal(
  proposal: Proposal,
  _cfg: AshlrConfig,
  client: { complete: (system: string, user: string) => Promise<string> },
): Promise<ManagerVerdict> {
  const fallback = (): ManagerVerdict => ({
    proposalId: proposal.id,
    verdict: 'review',
    value: 3,
    correctness: 3,
    scope: 3,
    alignment: 3,
    rationale: 'parse failure — defaulting to review',
    wouldMerge: false,
  });

  // Load vision spec context for this proposal's repo (best-effort; null = no spec).
  const specCtx = await loadSpecForProposal(proposal.repo ?? undefined);

  let raw: string;
  let fullReasoning = '';
  try {
    raw = await client.complete(JUDGE_SYSTEM, buildJudgePrompt(proposal, specCtx));
    fullReasoning = extractFullReasoning(raw);
  } catch {
    return fallback();
  }

  let obj = extractJson(raw);
  // ONE-SHOT RETRY: if parse failed, re-prompt the model asking for JSON only.
  if (!obj) {
    try {
      const retryPrompt = buildJudgePrompt(proposal, specCtx) + JUDGE_RETRY_SUFFIX;
      const raw2 = await client.complete(JUDGE_SYSTEM, retryPrompt);
      obj = extractJson(raw2);
    } catch { /* retry failed — fall through to fallback */ }
  }
  if (!obj) return fallback();

  const rawVerdict = typeof obj['verdict'] === 'string' ? obj['verdict'] : '';
  const verdict: ManagerVerdict['verdict'] = VALID_VERDICTS.has(rawVerdict)
    ? (rawVerdict as ManagerVerdict['verdict'])
    : normaliseVerdict(rawVerdict);

  const value = clamp(obj['value'], 1, 5);
  const correctness = clamp(obj['correctness'], 1, 5);
  const scope = clamp(obj['scope'], 1, 5);
  const alignment = clamp(obj['alignment'], 1, 5);
  const rationale =
    typeof obj['rationale'] === 'string' && obj['rationale'].length > 0
      ? obj['rationale'].slice(0, 200)
      : 'no rationale provided';

  // wouldMerge: advisory merge-safety flag (NEVER triggers actual merge).
  // True only when: ship + low risk + small scope (≤4 files, ≤150 diff lines).
  let wouldMerge = false;
  if (verdict === 'ship') {
    try {
      const { classifyRisk } = await import('../inbox/merge.js');
      const risk = classifyRisk(proposal);
      const diffLines = countDiffLines(proposal.diff);
      const diffFiles = countDiffFiles(proposal.diff);
      wouldMerge = risk === 'low' && diffFiles <= 4 && diffLines <= 150;
    } catch {
      wouldMerge = false;
    }
  }


  // M141: Record full judge trace for calibration / distillation.
  recordJudgeTrace({
    proposalId: proposal.id,
    judgeEngine: (client as { model?: string }).model ?? 'unknown',
    verdict,
    scores: { value, correctness, scope, alignment },
    fullReasoning,
    promptContext: `${proposal.title} | ${proposal.kind} | engine:${proposal.engineModel ?? 'unknown'}${specCtx ? ' | vision:true' : ''}`,
  });

  return { proposalId: proposal.id, verdict, value, correctness, scope, alignment, rationale, wouldMerge };
}

// ---------------------------------------------------------------------------
// ProviderClient interface (minimal — avoids importing the full provider-client
// module which has many side effects)
// ---------------------------------------------------------------------------

interface MinimalProviderClient {
  complete?: (system: string, user: string) => Promise<string>;
  chat?: (messages: Array<{ role: string; content: string }>) => Promise<{ content: string }>;
  completions?: { create: (opts: Record<string, unknown>) => Promise<{ choices: Array<{ message: { content: string } }> }> };
  model?: string;
}

/**
 * Wrap a ProviderClient into the simple `complete(system, user)` interface
 * the judge needs. Tries several API shapes gracefully.
 */
function wrapClient(
  raw: MinimalProviderClient,
): { complete: (system: string, user: string) => Promise<string>; model: string } | null {
  // Shape 1: already has a .complete() method (test mocks use this)
  if (typeof raw.complete === 'function') {
    return { complete: raw.complete.bind(raw), model: raw.model ?? 'unknown' };
  }

  // Shape 2: OpenAI-compatible .completions.create()
  if (raw.completions && typeof (raw.completions as Record<string, unknown>)['create'] === 'function') {
    const completions = raw.completions;
    return {
      model: raw.model ?? 'unknown',
      complete: async (system: string, user: string): Promise<string> => {
        const resp = await completions.create({
          model: raw.model ?? 'gpt-4',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 512,
          temperature: 0,
        });
        return resp.choices[0]?.message?.content ?? '';
      },
    };
  }

  // Shape 3: .chat() method
  if (typeof raw.chat === 'function') {
    const chat = raw.chat.bind(raw);
    return {
      model: raw.model ?? 'unknown',
      complete: async (system: string, user: string): Promise<string> => {
        const resp = await chat([
          { role: 'system', content: system },
          { role: 'user', content: user },
        ]);
        return resp.content;
      },
    };
  }

  return null;
}

/**
 * Direct Ollama chat completion with a long timeout (3 min) for slow 72b models.
 * Bypasses provider-client.ts's 30s FETCH_TIMEOUT_MS.
 */
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


// ---------------------------------------------------------------------------
// resolveJudgeClient — pick the best available judge
// ---------------------------------------------------------------------------

/**
 * Default model for the Claude CLI judge when cfg.foundry.managerJudgeModel
 * does not specify an explicit claude model.
 */
const CLAUDE_DEFAULT_JUDGE_MODEL = 'claude-sonnet-4-5';

/**
 * Build a `complete(system, user)` function that uses the Claude Code CLI
 * (`claude -p "<combined prompt>" --model <M> --output-format json`).
 *
 * Combines system + user into a single -p argument (the Claude CLI `-p` flag
 * takes one prompt; we embed the system persona as a prefix so the judge
 * persona is preserved). Parses the `.result` text out of the JSON output.
 *
 * Never-throws: any spawn/parse failure returns an empty string so the caller
 * falls through to the parse-failure → 'review' path.
 */
function buildClaudeCliComplete(
  cfg: AshlrConfig,
  model: string,
): (system: string, user: string) => Promise<string> {
  return async (system: string, user: string): Promise<string> => {
    try {
      const combined = `${system}\n\n${user}`;
      const cmd = buildEngineCommand('claude', combined, cfg, { model });
      if (!cmd) return '';
      const result = spawnEngine(cmd, cfg, { timeoutMs: 300_000 }); // 5 min for frontier
      if (!result.ok || !result.output) return '';
      // claude --output-format json → { result: "<text>", ... }
      try {
        const parsed = JSON.parse(result.output) as Record<string, unknown>;
        const text = parsed['result'];
        return typeof text === 'string' ? text : result.output;
      } catch {
        // Not JSON-wrapped (older claude versions) — return raw output.
        return result.output;
      }
    } catch {
      return '';
    }
  };
}

/**
 * Resolve the best available judge client for the manager.
 *
 * Priority order (controlled by cfg.foundry.managerJudgeEngine):
 *   1. 'auto' or 'claude' (default): Claude CLI if allowed + installed → most decisive
 *   2. 'local' or claude unavailable: ollamaDirectComplete with the 72b model
 *
 * Returns { complete, judgeEngine } — judgeEngine is the model id string to
 * record in the report. Never throws.
 */
function resolveJudgeClient(
  cfg: AshlrConfig,
  ollamaBaseUrl: string,
  judgeModel: string,
): { complete: (system: string, user: string) => Promise<string>; judgeEngine: string } {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  const managerJudgeEngine = (foundry?.['managerJudgeEngine'] as string | undefined) ?? 'auto';
  const allowedBackends: string[] = (foundry?.['allowedBackends'] as string[] | undefined) ?? ['builtin'];

  const wantClaude = managerJudgeEngine === 'auto' || managerJudgeEngine === 'claude';
  const claudeAllowed = allowedBackends.includes('claude');

  if (wantClaude && claudeAllowed && engineInstalled('claude', cfg)) {
    // Use cfg.foundry.managerJudgeModel if it looks like a claude model,
    // otherwise fall back to the sonnet default.
    const isClaudeModel = judgeModel.startsWith('claude') || judgeModel.includes('claude');
    const claudeModel = isClaudeModel ? judgeModel : CLAUDE_DEFAULT_JUDGE_MODEL;
    return {
      complete: buildClaudeCliComplete(cfg, claudeModel),
      judgeEngine: claudeModel,
    };
  }

  // Local-72b path (unchanged from original)
  const localBaseUrl = ollamaBaseUrl;
  const localModel = judgeModel;
  return {
    complete: (system: string, user: string) =>
      ollamaDirectComplete(localBaseUrl, localModel, system, user, 512, 0),
    judgeEngine: localModel,
  };
}

// ---------------------------------------------------------------------------
// Report output helpers
// ---------------------------------------------------------------------------

/** Directory for manager reports: ~/.ashlr/manager/ */
function managerDir(): string {
  return join(homedir(), '.ashlr', 'manager');
}

function writeReport(report: ManagerReport): void {
  try {
    const dir = managerDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = report.generatedAt.replace(/[:.]/g, '-');
    const file = join(dir, `${ts}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch {
    // Best-effort — report is still returned even if file write fails.
  }
}

// ---------------------------------------------------------------------------
// Narrative + recommendations
// ---------------------------------------------------------------------------

function buildNarrative(metrics: QualityMetrics, verdicts: ManagerVerdict[]): string {
  const total = verdicts.length;
  const ships = verdicts.filter((v) => v.verdict === 'ship').length;
  const noises = verdicts.filter((v) => v.verdict === 'noise').length;
  const harmful = verdicts.filter((v) => v.verdict === 'harmful').length;
  const reviews = total - ships - noises - harmful;

  const acceptPct = (metrics.acceptRate * 100).toFixed(1);
  return (
    `Fleet judged ${total} proposal(s) in the ${metrics.window} window. ` +
    `${ships} ready to ship, ${reviews} need review, ${noises} noise, ${harmful} harmful. ` +
    `Overall accept rate ${acceptPct}% (${metrics.merged} merged of ${metrics.proposalsCreated} created). ` +
    `Trivial ratio ${(metrics.trivialRatio * 100).toFixed(1)}%, empty-diff rate ${(metrics.emptyRate * 100).toFixed(1)}%.`
  );
}

function buildRecommendations(metrics: QualityMetrics, verdicts: ManagerVerdict[]): string[] {
  const recs: string[] = [];

  if (metrics.emptyRate > 0.3) {
    recs.push('High empty-diff rate — check engine prompts; many proposals lack a diff.');
  }
  if (metrics.trivialRatio > 0.5) {
    recs.push('Over half of proposals are trivial — route trivial tasks to a lighter engine.');
  }
  if (metrics.rejectRate > 0.5) {
    recs.push('Rejection rate is high — tune proposal quality gates or add a pre-filter.');
  }
  if (metrics.acceptRate < 0.1 && metrics.proposalsCreated > 5) {
    recs.push('Very low accept rate — review backlog quality or tighten spec generation.');
  }

  const noiseCount = verdicts.filter((v) => v.verdict === 'noise').length;
  if (noiseCount > 2) {
    recs.push(`${noiseCount} noise proposals detected — consider raising the minimum diff-size threshold.`);
  }
  const harmfulCount = verdicts.filter((v) => v.verdict === 'harmful').length;
  if (harmfulCount > 0) {
    recs.push(`${harmfulCount} harmful proposal(s) flagged — audit engine outputs and tighten confinement.`);
  }

  if (recs.length === 0) {
    recs.push('Fleet health looks nominal — no urgent tuning needed.');
  }
  return recs;
}

function buildConcerns(verdicts: ManagerVerdict[]): string[] {
  const concerns: string[] = [];
  const noisy = verdicts.filter((v) => v.verdict === 'noise');
  const harmful = verdicts.filter((v) => v.verdict === 'harmful');

  if (noisy.length > 0) {
    concerns.push(`Noise proposals (${noisy.length}): ${noisy.map((v) => v.proposalId).join(', ')}`);
  }
  if (harmful.length > 0) {
    concerns.push(`Harmful proposals (${harmful.length}): ${harmful.map((v) => v.proposalId).join(', ')}`);
  }

  // Low-value patterns
  const lowValue = verdicts.filter((v) => v.value <= 2);
  if (lowValue.length > 0) {
    concerns.push(`${lowValue.length} proposal(s) scored value ≤2 — low return on inference spend.`);
  }

  return concerns;
}

// ---------------------------------------------------------------------------
// Public: runManager()
// ---------------------------------------------------------------------------

/**
 * Run the fleet manager in shadow mode.
 *
 * @param cfg          - AshlrConfig (used for provider resolution)
 * @param opts.window  - Quality metrics window (default '7d')
 * @param opts.limit   - Max proposals to judge (default 20, bounded 1–100)
 * @param opts.applyRejects - When true, call setStatus(id,'rejected') for
 *                            noise/harmful proposals only. Default false (pure shadow).
 */
export async function runManager(
  cfg: AshlrConfig,
  opts: { window?: '7d' | '30d' | 'all'; limit?: number; applyRejects?: boolean } = {},
): Promise<ManagerReport> {
  const window = opts.window ?? '7d';
  const rawLimit = opts.limit ?? 20;
  const limit = Math.max(1, Math.min(100, rawLimit));
  const applyRejects = opts.applyRejects ?? false;

  const generatedAt = new Date().toISOString();
  let judgeEngine = 'local';

  // Always produce a safe fallback report on any catastrophic error.
  const emptyReport = (): ManagerReport => ({
    generatedAt,
    window,
    metrics: computeQualityMetrics(window),
    verdicts: [],
    wins: [],
    concerns: [],
    recommendations: ['runManager failed to initialize — check provider configuration.'],
    narrative: 'Manager could not run due to an initialization error.',
    judgeEngine,
  });

  try {
    // ── Resolve the frontier judge client ──────────────────────────────────
    // M135 priority order (controlled by cfg.foundry.managerJudgeEngine):
    //   1. resolveJudgeClient — Claude CLI (subscription) FIRST when managerJudgeEngine
    //      is 'auto'/'claude' AND claude is in allowedBackends AND engineInstalled('claude').
    //      Falls to local-72b when claude unavailable or managerJudgeEngine='local'.
    //   2. getActiveClient — cloud provider key / test mocks (used only when Step 1 yields
    //      nothing, i.e. resolveJudgeClient returned the local path AND the local fetch fails,
    //      OR when engineInstalled returns false in the test environment which means the mock
    //      in m120/m121 tests controls the path via getActiveClient).
    //
    // Rationale for reversal: getActiveClient ALWAYS returns a client in production (via its
    // ollamaDirectComplete fallback), so putting it first meant Claude CLI was NEVER reached.
    const judgeModel = ((cfg.foundry as Record<string, unknown> | undefined)?.['managerJudgeModel'] as string | undefined) || 'qwen2.5:72b-instruct-q4_K_M';
    const ollamaBase = (cfg.models as Record<string, unknown> | undefined)?.['ollama'] as string | undefined;
    const ollamaBaseUrl = (ollamaBase ?? 'http://localhost:11434').replace(/\/+$/, '') + '/v1';

    let judgeClient: { complete: (system: string, user: string) => Promise<string> } | null = null;

    // Step 1: resolveJudgeClient — Claude CLI when allowed+installed, else local-72b.
    // engineInstalled('claude') is the gating check: real binary must exist on PATH.
    // Tests that mock engineInstalled (m130) control which path fires.
    // Tests that don't mock engineInstalled (m120/m121) get false in CI (no real claude),
    // so they naturally fall through to Step 2 (getActiveClient mock).
    try {
      const resolved = resolveJudgeClient(cfg, ollamaBaseUrl, judgeModel);
      judgeClient = resolved;
      judgeEngine = resolved.judgeEngine;
    } catch {
      judgeEngine = 'unavailable';
      judgeClient = null;
    }

    // Step 2: if resolveJudgeClient chose the local-72b path (judgeEngine = localModel,
    // not a claude model), try getActiveClient as an additional fallback — this handles
    // test mocks (m120/m121 mock getActiveClient to return a deterministic client) and
    // cloud API keys when available.  We only override if getActiveClient succeeds AND
    // the current resolved engine is NOT a claude model (don't override a working claude path).
    const resolvedIsClaude = judgeEngine.startsWith('claude') || judgeEngine.includes('claude');
    if (!resolvedIsClaude) {
      try {
        const { getActiveClient } = await import('../run/provider-client.js');
        const rawClient = await getActiveClient(cfg, { allowCloud: true, model: judgeModel }) as MinimalProviderClient;
        const wrapped = wrapClient(rawClient);
        if (wrapped) {
          judgeClient = wrapped;
          judgeEngine = wrapped.model ?? 'cloud';
        }
      } catch { /* fall through — keep the resolveJudgeClient result */ }
    }

    // ── Load pending proposals ─────────────────────────────────────────────
    let proposals: Proposal[] = [];
    try {
      const { listProposals } = await import('../inbox/store.js');
      proposals = listProposals({ status: 'pending' }).slice(0, limit);
    } catch {
      proposals = [];
    }

    // ── Judge each proposal ────────────────────────────────────────────────
    const verdicts: ManagerVerdict[] = [];

    for (const proposal of proposals) {
      let verdict: ManagerVerdict;

      if (judgeClient) {
        verdict = await judgeProposal(proposal, cfg, judgeClient);
      } else {
        // No client — default every proposal to 'review' (never auto-reject).
        verdict = {
          proposalId: proposal.id,
          verdict: 'review',
          value: 3,
          correctness: 3,
          scope: 3,
          alignment: 3,
          rationale: 'no judge available — defaulting to review',
          wouldMerge: false,
        };
      }

      verdicts.push(verdict);

      // Record in decisions ledger (always, shadow or not).
      recordDecision({
        ts: new Date().toISOString(),
        proposalId: proposal.id,
        action: 'judged',
        engine: judgeEngine,
        model: judgeEngine,
        verdict: verdict.verdict,
        reason: verdict.rationale,
        detail: verdict.wouldMerge ? 'would-merge' : '',
      });

      // applyRejects: only reject noise/harmful (never ship/review).
      if (applyRejects && (verdict.verdict === 'noise' || verdict.verdict === 'harmful')) {
        try {
          const { setStatus } = await import('../inbox/store.js');
          setStatus(proposal.id, 'rejected', undefined, verdict.rationale);
        } catch {
          // Best-effort — never throws.
        }
      }
    }

    // ── Aggregate metrics + report ─────────────────────────────────────────
    const metrics = computeQualityMetrics(window);

    const wins = verdicts
      .filter((v) => v.verdict === 'ship')
      .map((v) => {
        const p = proposals.find((x) => x.id === v.proposalId);
        return p ? `${v.proposalId}: ${p.title}` : v.proposalId;
      });

    const concerns = buildConcerns(verdicts);
    const recommendations = buildRecommendations(metrics, verdicts);
    const narrative = buildNarrative(metrics, verdicts);

    const report: ManagerReport = {
      generatedAt,
      window,
      metrics,
      verdicts,
      wins,
      concerns,
      recommendations,
      narrative,
      judgeEngine,
    };

    writeReport(report);
    return report;

  } catch {
    return emptyReport();
  }
}
