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
import { computeQualityMetrics } from './quality-metrics.js';

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

const JUDGE_SYSTEM = `You are the fleet manager for an autonomous coding assistant.
Your job: evaluate whether a code proposal is worth shipping, needs review, is noise, or is harmful.

Respond ONLY with valid JSON (no prose, no markdown fences):
{
  "verdict": "ship" | "review" | "noise" | "harmful",
  "value": <1-5>,
  "correctness": <1-5>,
  "scope": <1-5>,
  "alignment": <1-5>,
  "rationale": "<one sentence>"
}

Scoring guide:
  value       — how much does this improve the codebase? (1=trivial, 5=critical)
  correctness — how confident are you the change is correct? (1=suspicious, 5=clearly correct)
  scope       — blast radius (1=single line, 5=touches many files / risky)
  alignment   — does this match the repo's evident purpose? (1=unrelated, 5=perfectly aligned)

verdict guide:
  ship    — value≥4, correctness≥4, no obvious risk
  review  — uncertain; needs human inspection
  noise   — trivial, no diff, or clearly low-value
  harmful — dangerous, destructive, or security-risk

When in doubt, use "review". Never use "noise" or "harmful" speculatively.`;

function buildJudgePrompt(proposal: Proposal): string {
  return `Proposal to judge:

Title: ${proposal.title}
Summary: ${proposal.summary}
Kind: ${proposal.kind}
Engine: ${proposal.engineModel ?? 'unknown'}

Diff:
${truncateDiff(proposal.diff)}`;
}

/** Attempt to extract JSON from a potentially prose-wrapped LLM response. */
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

  // Find the first {...} block.
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  return null;
}

const VALID_VERDICTS = new Set(['ship', 'review', 'noise', 'harmful']);

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

  let raw: string;
  try {
    raw = await client.complete(JUDGE_SYSTEM, buildJudgePrompt(proposal));
  } catch {
    return fallback();
  }

  const obj = extractJson(raw);
  if (!obj) return fallback();

  const rawVerdict = typeof obj['verdict'] === 'string' ? obj['verdict'] : '';
  const verdict = VALID_VERDICTS.has(rawVerdict)
    ? (rawVerdict as ManagerVerdict['verdict'])
    : 'review';

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
    let rawClient: MinimalProviderClient | null = null;

    try {
      const { getActiveClient } = await import('../run/provider-client.js');
      // Prefer cloud (frontier) judge; fall back to local if unavailable.
      try {
        rawClient = await getActiveClient(cfg, { allowCloud: true }) as MinimalProviderClient;
        judgeEngine = (rawClient as { model?: string }).model ?? 'cloud';
      } catch {
        // No cloud available — try local.
        try {
          rawClient = await getActiveClient(cfg, { allowCloud: false }) as MinimalProviderClient;
          judgeEngine = (rawClient as { model?: string }).model ?? 'local';
        } catch {
          rawClient = null;
          judgeEngine = 'unavailable';
        }
      }
    } catch {
      rawClient = null;
      judgeEngine = 'unavailable';
    }

    const judgeClient = rawClient ? wrapClient(rawClient) : null;

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
