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
import { hashDiff, signJudgeAttestation } from '../foundry/provenance.js';
import { computeQualityMetrics } from './quality-metrics.js';
import { renderPlaybook } from '../vision/playbook.js';
import { engineInstalled, buildEngineCommand, spawnEngine } from '../run/engines.js';
import { peekBackendAvailability } from '../fabric/resource-monitor.js';
import { CLAUDE5_FABLE_API_ID, fableEnabled } from '../run/model-catalog.js';

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
   * True only when: verdict==='ship' AND the proposal fits the configured
   * auto-merge risk/scope bounds. NEVER true for noise/harmful. Never triggers
   * any actual merge — purely informational; merge gates re-check everything.
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
  const MAX = 30000; // M300e: raised from 6144 — codex judged correctness=3 because the diff was truncated; show more so it can fully assess
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
              ship=value≥3 AND correctness≥4 AND no obvious risk
                   (a USEFUL, correct, well-tested change SHIPS — it need NOT be
                    critical/value-5. The autonomous fleet's job is a steady stream
                    of good, correct improvements, so value=3 "useful" work with
                    high correctness is shippable. Correctness is the hard bar.)
              review=correctness≤3 (NOT confident the change is correct) OR
                     value≤2 (trivial / not worth merging) OR genuinely needs a human look
              noise=trivial/no diff/spam
              harmful=dangerous/destructive/security risk
              When uncertain about CORRECTNESS choose review. Never choose noise or harmful speculatively.
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

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVerdictJson(value: unknown): value is JsonRecord {
  if (!isJsonRecord(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'verdict')) return true;

  // Single score-like fields appear in provider telemetry envelopes. Treat a
  // score-only object as verdict JSON only when it carries the complete rubric.
  return (
    Object.prototype.hasOwnProperty.call(value, 'value') &&
    Object.prototype.hasOwnProperty.call(value, 'correctness') &&
    Object.prototype.hasOwnProperty.call(value, 'scope') &&
    Object.prototype.hasOwnProperty.call(value, 'alignment')
  );
}

function addTextCandidate(candidates: string[], text: unknown): void {
  if (typeof text === 'string' && text.trim().length > 0) candidates.push(text);
}

function textBlockCandidates(value: unknown): string[] {
  const candidates: string[] = [];
  if (typeof value === 'string') {
    addTextCandidate(candidates, value);
    return candidates;
  }
  if (Array.isArray(value)) {
    for (const item of value) candidates.push(...textBlockCandidates(item));
    return candidates;
  }
  if (!isJsonRecord(value)) return candidates;

  const type = typeof value['type'] === 'string' ? value['type'] : '';
  if (
    typeof value['text'] === 'string' &&
    (type === '' || type === 'text' || type === 'output_text' || type === 'input_text')
  ) {
    addTextCandidate(candidates, value['text']);
  }
  return candidates;
}

function knownTextFieldCandidates(value: unknown): string[] {
  const candidates: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) candidates.push(...knownTextFieldCandidates(item));
    return candidates;
  }
  if (!isJsonRecord(value)) return candidates;

  addTextCandidate(candidates, value['result']);
  candidates.push(...textBlockCandidates(value['content']));

  const message = value['message'];
  if (isJsonRecord(message)) {
    candidates.push(...textBlockCandidates(message['content']));
  }

  candidates.push(...textBlockCandidates(value));

  for (const nested of Object.values(value)) {
    if (isJsonRecord(nested) || Array.isArray(nested)) {
      candidates.push(...knownTextFieldCandidates(nested));
    }
  }

  return candidates;
}

function parseJsonValues(raw: string): unknown[] {
  const values: unknown[] = [];
  try {
    values.push(JSON.parse(raw.trim()));
  } catch { /* fall through */ }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch { /* ignore non-JSON log lines */ }
  }

  return values;
}

function normaliseJudgeTextCandidates(raw: string): string[] {
  const candidates = [raw];
  for (const value of parseJsonValues(raw)) {
    candidates.push(...knownTextFieldCandidates(value));
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return false;
    seen.add(trimmed);
    return true;
  });
}

function extractJson(raw: string): Record<string, unknown> | null {
  // Try direct parse first.
  try {
    const parsed = JSON.parse(raw.trim());
    if (isVerdictJson(parsed)) return parsed;
  } catch { /* fall through */ }

  // Strip markdown fences.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (isVerdictJson(parsed)) return parsed;
    } catch { /* fall through */ }
  }

  // Find the {...} block that is the VERDICT (M300c). Models — especially the
  // codex CLI — emit OTHER JSON objects (event/telemetry envelopes) AFTER the
  // verdict, so the naive "last {...}" grabbed a non-verdict object whose missing
  // value/correctness fields clamped to 1. Prefer the LAST {...} that carries
  // verdict fields; arbitrary event JSON is handled by text-candidate
  // normalisation above, not treated as a verdict.
  const allBraceMatches = [...raw.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*/g)];
  for (let i = allBraceMatches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(allBraceMatches[i]![0]);
      if (isVerdictJson(parsed)) return parsed;
    } catch { /* keep scanning */ }
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
        if (isVerdictJson(parsed)) return parsed;
      } catch { /* fall through */ }
    }
  }

  return null;
}

function parseStrictReasoning(raw: string): Record<string, unknown> | null {
  const prose = extractFullReasoning(raw) || raw;
  const rNum = (label: string): number | null => {
    const m = prose.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:=]\\s*([1-5])\\b`, 'i'));
    return m ? Number(m[1]) : null;
  };

  const value = rNum('VALUE');
  const correctness = rNum('CORRECTNESS');
  const scope = rNum('SCOPE');
  const alignment = rNum('ALIGNMENT');
  const verdictMatch = prose.match(/(?:^|\n)\s*VERDICT\s*[:=]\s*(ship|review|noise|harmful)\b/i);
  if (
    value === null ||
    correctness === null ||
    scope === null ||
    alignment === null ||
    !verdictMatch?.[1]
  ) {
    return null;
  }

  const rationaleMatch = prose.match(/(?:^|\n)\s*RATIONALE\s*[:=]\s*(.+?)(?:\n|$)/i);
  const verdict = verdictMatch[1].toLowerCase() as ManagerVerdict['verdict'];
  const rationale =
    rationaleMatch?.[1]?.trim() ||
    verdictMatch[0].replace(/^\s*VERDICT\s*[:=]\s*/i, '').trim() ||
    'structured reasoning verdict';

  return { value, correctness, scope, alignment, verdict, rationale };
}

function parseJudgeResponse(raw: string): { obj: Record<string, unknown> | null; fullReasoning: string } {
  const candidates = normaliseJudgeTextCandidates(raw);
  const fullReasoning = candidates.map(extractFullReasoning).find((r) => r.length > 0) ?? '';

  for (const candidate of candidates) {
    const obj = extractJson(candidate);
    if (obj) return { obj, fullReasoning };
  }

  for (const candidate of candidates) {
    const obj = parseStrictReasoning(candidate);
    if (obj) return { obj, fullReasoning: fullReasoning || extractFullReasoning(candidate) || candidate.trim() };
  }

  return { obj: null, fullReasoning };
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

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;

function autoMergeBounds(cfg: AshlrConfig): {
  maxRisk: 'low' | 'medium' | 'high';
  maxFiles: number;
  maxLines: number;
} {
  const autoMerge =
    ((cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge'] as
      | Record<string, unknown>
      | undefined) ?? {};
  const maxRisk =
    autoMerge['maxRisk'] === 'medium' || autoMerge['maxRisk'] === 'high'
      ? autoMerge['maxRisk']
      : 'low';
  const maxFiles =
    typeof autoMerge['maxAutomergeFiles'] === 'number' && autoMerge['maxAutomergeFiles'] >= 1
      ? Math.floor(autoMerge['maxAutomergeFiles'])
      : 4;
  const maxLines =
    typeof autoMerge['maxAutomergeLines'] === 'number' && autoMerge['maxAutomergeLines'] >= 1
      ? Math.floor(autoMerge['maxAutomergeLines'])
      : 150;
  return { maxRisk, maxFiles, maxLines };
}

/**
 * Call the frontier model and parse its verdict.
 * On any parse/network failure returns a safe 'review' verdict.
 */
export async function judgeProposal(
  proposal: Proposal,
  cfg: AshlrConfig,
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

  // M149: ACE Playbook — inject accumulated judge lessons into the rubric when flag on.
  const acePlaybook = (cfg.foundry as Record<string, unknown> | undefined)?.['acePlaybook'] === true;
  const judgePlaybookCtx = acePlaybook ? renderPlaybook('judge', 300) : '';
  const effectiveJudgeSystem = judgePlaybookCtx
    ? `${JUDGE_SYSTEM}\n\n${judgePlaybookCtx}`
    : JUDGE_SYSTEM;

  let raw: string;
  let fullReasoning = '';
  try {
    raw = await client.complete(effectiveJudgeSystem, buildJudgePrompt(proposal, specCtx));
  } catch {
    return fallback();
  }

  const parsed = parseJudgeResponse(raw);
  let obj = parsed.obj;
  fullReasoning = parsed.fullReasoning;
  // ONE-SHOT RETRY: if parse failed, re-prompt the model asking for JSON only.
  if (!obj) {
    try {
      const retryPrompt = buildJudgePrompt(proposal, specCtx) + JUDGE_RETRY_SUFFIX;
      const raw2 = await client.complete(effectiveJudgeSystem, retryPrompt);
      const retryParsed = parseJudgeResponse(raw2);
      obj = retryParsed.obj;
      fullReasoning = fullReasoning || retryParsed.fullReasoning;
    } catch { /* retry failed — fall through to fallback */ }
  }
  // M300d: parse scores/verdict from the structured <reasoning> prose
  // (VALUE: N / CORRECTNESS: N / ... / VERDICT: x) as a robust fallback. Some
  // engines (notably the codex CLI) reliably emit that reasoning block but NOT a
  // strict trailing {"value":..} JSON, so extractJson found a non-verdict object
  // and every field clamped to 1 (a parse artifact, not a real judgment). We use
  // a reasoning-derived score whenever the JSON omitted that field.
  const rprose = fullReasoning;
  const rNum = (label: string): number | undefined => {
    const m = rprose.match(new RegExp(label + '\\s*[:=]\\s*(\\d)', 'i'));
    return m ? Number(m[1]) : undefined;
  };
  const rVerdictM = rprose.match(/VERDICT\s*[:=]\s*(ship|review|noise|harmful)\b/i);

  if (!obj) return fallback();

  const jsonVerdict = typeof obj['verdict'] === 'string' ? obj['verdict'] : undefined;
  const reasoningVerdict = rVerdictM?.[1]?.toLowerCase();
  const verdict: ManagerVerdict['verdict'] = jsonVerdict
    ? (VALID_VERDICTS.has(jsonVerdict.toLowerCase())
        ? (jsonVerdict.toLowerCase() as ManagerVerdict['verdict'])
        : normaliseVerdict(jsonVerdict))
    : ((reasoningVerdict as ManagerVerdict['verdict'] | undefined) ?? 'review');

  const value = clamp(obj['value'] ?? rNum('VALUE'), 1, 5);
  const correctness = clamp(obj['correctness'] ?? rNum('CORRECTNESS'), 1, 5);
  const scope = clamp(obj['scope'] ?? rNum('SCOPE'), 1, 5);
  const alignment = clamp(obj['alignment'] ?? rNum('ALIGNMENT'), 1, 5);
  const rationale =
    typeof obj['rationale'] === 'string' && obj['rationale'].length > 0
      ? obj['rationale'].slice(0, 200)
      : 'no rationale provided';

  // wouldMerge is advisory only. The merge gate independently re-checks
  // verification, provenance, risk, scope, enrollment, policy, and kill switch.
  let wouldMerge = false;
  if (verdict === 'ship') {
    try {
      const { classifyRisk } = await import('../inbox/merge.js');
      const risk = classifyRisk(proposal);
      const diffLines = countDiffLines(proposal.diff);
      const diffFiles = countDiffFiles(proposal.diff);
      const bounds = autoMergeBounds(cfg);
      wouldMerge =
        RISK_ORDER[risk] <= RISK_ORDER[bounds.maxRisk] &&
        diffFiles <= bounds.maxFiles &&
        diffLines <= bounds.maxLines;
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
 * M320: default model for the Claude CLI judge when cfg.foundry.managerJudgeModel
 * does not specify an explicit claude model. Fable 5 (Mythos-class — the
 * strongest available judge; its quality compounds through every auto-merge
 * decision) when cfg.foundry.claude5.fable is on; Opus 4.8 otherwise. Fable
 * calls that fail, are refused, or return empty retry once on the Opus
 * fallback inside buildClaudeCliComplete — a judge pass never dies because
 * Fable is unavailable on this account.
 */
const CLAUDE_JUDGE_FALLBACK_MODEL = 'claude-opus-4-8';
function defaultClaudeJudgeModel(cfg: AshlrConfig): string {
  return fableEnabled(cfg) ? CLAUDE5_FABLE_API_ID : CLAUDE_JUDGE_FALLBACK_MODEL;
}

/**
 * M322: per-call judge telemetry captured from the CLI JSON output.
 * `model` is the model that ACTUALLY answered — a Fable primary that fell
 * back to Opus reports Opus, so the ledger never lies about the answering
 * model. All fields best-effort; absent on local/ollama judge paths.
 */
interface JudgeCallStats {
  model?: string;
  durationMs?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

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
  stats?: JudgeCallStats,
): (system: string, user: string) => Promise<string> {
  const primary = buildClaudeCliCompleteSingle(cfg, model, stats);
  // M320: Fable 5 judge calls fall back to Opus 4.8 when the primary call
  // fails, is refused by safety classifiers, or returns empty — the empty
  // string is the never-throw failure signal of the single-shot path, so
  // `|| fallback(...)` covers all three. Non-Fable models keep the exact
  // pre-M320 single-shot behavior.
  if (model !== CLAUDE5_FABLE_API_ID) return primary;
  const fallback = buildClaudeCliCompleteSingle(cfg, CLAUDE_JUDGE_FALLBACK_MODEL, stats);
  return async (system: string, user: string): Promise<string> => {
    const out = await primary(system, user);
    return out || fallback(system, user);
  };
}

function buildClaudeCliCompleteSingle(
  cfg: AshlrConfig,
  model: string,
  stats?: JudgeCallStats,
): (system: string, user: string) => Promise<string> {
  return async (system: string, user: string): Promise<string> => {
    try {
      // M337 (review fix): reset the shared holder EVERY call — a failed or
      // usage-less call must record NOTHING, never the previous proposal's
      // model/cost/tokens (the ledger must not lie about the answering model).
      if (stats) {
        delete stats.model;
        delete stats.durationMs;
        delete stats.costUsd;
        delete stats.tokensIn;
        delete stats.tokensOut;
      }
      const t0 = Date.now();
      const combined = `${system}\n\n${user}`;
      const cmd = buildEngineCommand('claude', combined, cfg, { model });
      if (!cmd) return '';
      const result = await spawnEngine(cmd, cfg, { timeoutMs: 300_000 }); // 5 min for frontier
      if (!result.ok || !result.output) return '';
      // claude --output-format json → { result: "<text>", total_cost_usd, usage, ... }
      try {
        const parsed = JSON.parse(result.output) as Record<string, unknown>;
        const text = parsed['result'];
        // M322: capture per-call telemetry (best-effort — fields only set when
        // the CLI JSON carries them). Judge spend was previously invisible.
        if (stats) {
          stats.model = model;
          stats.durationMs = Date.now() - t0;
          const cost = parsed['total_cost_usd'];
          if (typeof cost === 'number') stats.costUsd = cost;
          const usage = parsed['usage'];
          if (usage !== null && typeof usage === 'object') {
            const u = usage as Record<string, unknown>;
            if (typeof u['input_tokens'] === 'number') stats.tokensIn = u['input_tokens'];
            if (typeof u['output_tokens'] === 'number') stats.tokensOut = u['output_tokens'];
          }
        }
        return typeof text === 'string' ? text : result.output;
      } catch {
        // Not JSON-wrapped (older claude versions) — return raw output.
        if (stats) {
          stats.model = model;
          stats.durationMs = Date.now() - t0;
        }
        return result.output;
      }
    } catch {
      return '';
    }
  };
}

/**
 * Build a `complete(system, user)` function that uses the Codex CLI
 * (`codex exec [--model M] --cd CWD --json "<combined prompt>"`).
 *
 * Mirrors buildClaudeCliComplete. The Codex CLI `exec` subcommand takes a
 * JSON-wrapped goal via --json; output is plain text (the agent's response).
 *
 * Never-throws: any spawn/parse failure returns an empty string so the caller
 * falls through to the parse-failure → 'review' path.
 */
function buildCodexCliComplete(
  cfg: AshlrConfig,
  model: string,
  stats?: JudgeCallStats,
): (system: string, user: string) => Promise<string> {
  return async (system: string, user: string): Promise<string> => {
    try {
      // M337 (review fix): reset the shared holder EVERY call (see the claude
      // single-shot builder above).
      if (stats) {
        delete stats.model;
        delete stats.durationMs;
        delete stats.costUsd;
        delete stats.tokensIn;
        delete stats.tokensOut;
      }
      const t0 = Date.now();
      const combined = `${system}\n\n${user}`;
      const cmd = buildEngineCommand('codex', combined, cfg, { model });
      if (!cmd) return '';
      const result = await spawnEngine(cmd, cfg, { timeoutMs: 300_000 }); // 5 min for frontier
      if (!result.ok || !result.output) return '';
      // codex output is plain text — model + latency only (no parseable usage).
      if (stats) {
        stats.model = model;
        stats.durationMs = Date.now() - t0;
      }
      return result.output;
    } catch {
      return '';
    }
  };
}

/**
 * Resolve the best available judge client for the manager.
 *
 * Priority order (controlled by cfg.foundry.managerJudgeEngine):
 *   1. 'auto' or 'claude' (default): Claude CLI if installed AND not exhausted.
 *      allowedBackends does NOT gate the judge (oversight role, not execution).
 *      Use cfg.foundry.judgeAllowedBackends to explicitly restrict judge backends.
 *   2. M300 'codex' or claude exhausted: Codex CLI if installed.
 *      managerJudgeEngine='codex' forces codex; 'auto' + claude exhausted falls here.
 *   3. 'local' or all frontier unavailable: ollamaDirectComplete with the 72b model
 *
 * Returns { complete, judgeEngine } — judgeEngine is the model id string to
 * record in the report. Never throws.
 */
function resolveJudgeClient(
  cfg: AshlrConfig,
  ollamaBaseUrl: string,
  judgeModel: string,
): {
  complete: (system: string, user: string) => Promise<string>;
  judgeEngine: string;
  /** M322: shared telemetry holder — populated per call by the CLI complete fns. */
  stats: JudgeCallStats;
} {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  const managerJudgeEngine = (foundry?.['managerJudgeEngine'] as string | undefined) ?? 'auto';
  const stats: JudgeCallStats = {};

  // M274: The judge is an OVERSIGHT role, not a proposal-execution backend.
  // cfg.foundry.allowedBackends restricts which engines may EXECUTE proposals
  // (run diffs, spawn agents). It must NOT gate the judge — doing so caused the
  // default ['builtin'] allowedBackends to silently exclude the Claude CLI judge,
  // leaving only Ollama whose engine string fails isFrontierJudge() in the merge
  // gate, so proposals could never receive a signed 'ship' attestation and the
  // fleet drained but never merged. Fix: use cfg.foundry.judgeAllowedBackends
  // when present (operator explicit control); otherwise allow claude for the
  // judge role regardless of allowedBackends (execution restriction ≠ oversight).
  const rawJudgeBackends = foundry?.['judgeAllowedBackends'] as string[] | undefined;
  // judgeAllowedBackends explicitly set → use it exclusively for judge gating.
  // Not set → allow claude for judging (allowedBackends is irrelevant here).
  const claudeAllowedForJudge = rawJudgeBackends
    ? rawJudgeBackends.includes('claude')
    : true; // default: claude is always allowed as judge when installed

  const wantClaude = managerJudgeEngine === 'auto' || managerJudgeEngine === 'claude';
  const wantCodex = managerJudgeEngine === 'codex';

  // M300: resource-aware judge — if cached Claude headroom says unavailable,
  // preserve it for operators and fall to Codex/local instead. This does not
  // fabricate spend accounting; it only honors measured availability.
  // peekBackendAvailability reads the in-memory snapshot cache synchronously (no I/O,
  // never throws). Returns null when no fresh cache → permissive (try claude first).
  let claudeUnavailableByResource = false;
  try {
    const claudeAvail = peekBackendAvailability('claude');
    if (claudeAvail === 'exhausted' || claudeAvail === 'unreachable' || claudeAvail === 'throttled') {
      claudeUnavailableByResource = true;
    }
  } catch {
    // never throws — treat as available
  }

  // Step 1: Claude CLI (primary frontier judge).
  if (wantClaude && claudeAllowedForJudge && !claudeUnavailableByResource && engineInstalled('claude', cfg)) {
    // Use cfg.foundry.managerJudgeModel if it looks like a claude model,
    // otherwise fall back to the sonnet default.
    const isClaudeModel = judgeModel.startsWith('claude') || judgeModel.includes('claude');
    const claudeModel = isClaudeModel ? judgeModel : defaultClaudeJudgeModel(cfg);
    return {
      complete: buildClaudeCliComplete(cfg, claudeModel, stats),
      judgeEngine: claudeModel,
      stats,
    };
  }

  // Step 2: M300 Codex CLI judge — explicit 'codex' setting OR auto + claude exhausted.
  // codex is a genuine frontier model (gpt-5.5); its judge attestations pass isFrontierJudge.
  const useCodex = wantCodex || (wantClaude && claudeUnavailableByResource);
  if (useCodex && engineInstalled('codex', cfg)) {
    // Use managerJudgeModel if it looks like a codex/gpt model, else the registry default.
    const isCodexModel = judgeModel.startsWith('gpt-') || judgeModel.startsWith('codex-') || judgeModel === 'gpt-5.5';
    const codexDefaultModel = 'gpt-5.5';
    const codexModel = isCodexModel ? judgeModel : codexDefaultModel;
    return {
      complete: buildCodexCliComplete(cfg, codexModel, stats),
      judgeEngine: codexModel,
      stats,
    };
  }

  // Step 3: Local-72b path (unchanged from original)
  const localBaseUrl = ollamaBaseUrl;
  const localModel = judgeModel;
  return {
    complete: (system: string, user: string) =>
      ollamaDirectComplete(localBaseUrl, localModel, system, user, 512, 0),
    judgeEngine: localModel,
    stats,
  };
}

// ---------------------------------------------------------------------------
// M176: Public frontier-judge resolver (used by automerge-pass.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve the best available frontier judge client using the M135/M274 priority
 * order (Claude CLI first when installed, else local-72b via ollama).
 *
 * M274: allowedBackends no longer gates the judge. The judge is an oversight
 * role; allowedBackends restricts execution backends. Use judgeAllowedBackends
 * to explicitly restrict judge backends. This fix ensures Claude CLI is reached
 * when installed even when allowedBackends=['builtin'] (the default).
 *
 * This is the SAME resolver used by runManager — exported so that
 * runAutoMergePass can use the identical path instead of the broken
 * getActiveClient-only path that returns hasComplete=false when
 * cfg.models.providerChain is ["ollama"].
 *
 * Returns { complete, model } in the shape judgeProposal expects, or null
 * when even the local fallback cannot be constructed (never throws).
 */
export function resolveFrontierJudgeClient(
  cfg: AshlrConfig,
): { complete: (system: string, user: string) => Promise<string>; model: string } | null {
  try {
    const judgeModel =
      ((cfg.foundry as Record<string, unknown> | undefined)?.['managerJudgeModel'] as string | undefined) ||
      'qwen2.5:72b-instruct-q4_K_M';
    const ollamaBase = (cfg.models as Record<string, unknown> | undefined)?.['ollama'] as string | undefined;
    const ollamaBaseUrl = (ollamaBase ?? 'http://localhost:11434').replace(/\/+$/, '') + '/v1';
    const resolved = resolveJudgeClient(cfg, ollamaBaseUrl, judgeModel);
    return { complete: resolved.complete, model: resolved.judgeEngine };
  } catch {
    return null;
  }
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
    let judgeStats: JudgeCallStats | null = null;

    // Step 1: resolveJudgeClient — Claude CLI when allowed+installed, else local-72b.
    // engineInstalled('claude') is the gating check: real binary must exist on PATH.
    // Tests that mock engineInstalled (m130) control which path fires.
    // Tests that don't mock engineInstalled (m120/m121) get false in CI (no real claude),
    // so they naturally fall through to Step 2 (getActiveClient mock).
    try {
      const resolved = resolveJudgeClient(cfg, ollamaBaseUrl, judgeModel);
      judgeClient = resolved;
      judgeEngine = resolved.judgeEngine;
      judgeStats = resolved.stats;
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

      // M157: For frontier 'ship' verdicts, HMAC-sign the attestation tuple so
      // evaluateVerificationGate can verify it cryptographically. A forged
      // ledger entry cannot pass without the host-local provenance key.
      // Only sign when the judge is frontier and explicitly says it would merge.
      // A `ship` verdict with wouldMerge=false is useful feedback, but it is
      // not merge-authority evidence.
      let judgeAttestation: string | undefined;
      // M300: accept codex/gpt-5.5 frontier models in addition to claude-* (mirrors isFrontierJudge in merge.ts)
      const isFrontierJudgeModel =
        judgeEngine.startsWith('claude') || judgeEngine.includes('claude') ||
        judgeEngine.startsWith('gpt-5') || judgeEngine.startsWith('codex-') || judgeEngine === 'codex';
      if (verdict.verdict === 'ship' && verdict.wouldMerge === true && isFrontierJudgeModel) {
        try {
          const diffHash = hashDiff(proposal.diff ?? '');
          judgeAttestation = signJudgeAttestation({
            proposalId: proposal.id,
            judgeEngine,
            verdict: 'ship',
            diffHash,
          });
        } catch {
          // Best-effort — a signing failure means no attestation; the gate will
          // refuse (fail-closed) rather than accept an unsigned 'ship'.
          judgeAttestation = undefined;
        }
      }

      // Record in decisions ledger (always, shadow or not).
      recordDecision({
        ts: new Date().toISOString(),
        proposalId: proposal.id,
        ...(proposal.workItemId ? { workItemId: proposal.workItemId } : {}),
        ...(proposal.workSource ? { workSource: proposal.workSource } : {}),
        ...(proposal.runId ? { runId: proposal.runId } : {}),
        action: 'judged',
        engine: judgeEngine,
        // M322: record the model that ACTUALLY answered (fallback-aware — a
        // Fable primary that fell back to Opus reports Opus) plus per-call
        // cost/tokens/latency parsed from the CLI JSON. Judge spend was
        // previously invisible; with Fable 5 judging it must be measured.
        model: judgeStats?.model ?? judgeEngine,
        ...(judgeStats?.durationMs !== undefined ? { durationMs: judgeStats.durationMs } : {}),
        ...(judgeStats?.costUsd !== undefined ? { costUsd: judgeStats.costUsd } : {}),
        ...(judgeStats?.tokensIn !== undefined ? { tokensIn: judgeStats.tokensIn } : {}),
        ...(judgeStats?.tokensOut !== undefined ? { tokensOut: judgeStats.tokensOut } : {}),
        verdict: verdict.verdict,
        reason: verdict.rationale,
        detail: verdict.wouldMerge ? 'would-merge' : '',
        ...(judgeAttestation !== undefined ? { judgeAttestation } : {}),
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
