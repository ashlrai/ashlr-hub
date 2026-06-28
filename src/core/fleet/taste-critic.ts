/**
 * taste-critic.ts — M183: Frontier (Opus) TASTE critic for SELECTION.
 *
 * Judges "does this make the cut" on the axes that matter for bold creative
 * work: VISION-ALIGNMENT, AMBITION/IMPACT, and DESIGN TASTE.
 *
 * This is a SELECTION + CURATION aid. It does NOT weaken the safety gate
 * (correctness/risk remain the floor in automerge-pass.ts). This only
 * influences which candidate best-of-N promotes as the winner.
 *
 * Usage:
 *   import { scoreTaste } from '../fleet/taste-critic.js'
 *   const taste = await scoreTaste(proposal, { repo, direction }, cfg)
 *
 * Never throws — on any failure returns a neutral 'solid' verdict.
 */

import type { AshlrConfig, Proposal } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TasteVerdict = 'gold' | 'solid' | 'mediocre';

export interface TasteScore {
  /** 1–5: How well this advances the tool's stated direction/vision. */
  alignment: number;
  /** 1–5: Ambition + impact of the change — bold > incremental. */
  ambition: number;
  /** 1–5: Design taste — clean, minimal, elegant vs. hacky/verbose. */
  design: number;
  /** Overall 1–5 (not a simple average — frontier weighting). */
  overall: number;
  /** 'gold' ≥ 4.0 overall; 'mediocre' ≤ 2.0; otherwise 'solid'. */
  verdict: TasteVerdict;
  /** Short rationale from the frontier critic (1–2 sentences). */
  rationale: string;
}

/** Context the caller supplies to help the critic judge alignment. */
export interface TasteContext {
  /** Absolute path of the repo (used as an identifier only — not read). */
  repo?: string | null;
  /**
   * Short description of the tool's current direction / north-star.
   * When absent the critic falls back to built-in ashlr direction summary.
   */
  direction?: string | null;
}

// ---------------------------------------------------------------------------
// Internal: neutral fallback returned on any failure
// ---------------------------------------------------------------------------

function neutralScore(rationale: string): TasteScore {
  return {
    alignment: 3,
    ambition: 3,
    design: 3,
    overall: 3,
    verdict: 'solid',
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Internal: simple secret scrubber
// Removes common secret patterns (API keys, tokens, passwords) from the
// text before sending to the frontier. Conservative — only strips obvious
// patterns.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  // Generic API key / token patterns
  /\b(sk|pk|api[_-]?key|token|secret|password|passwd|credential)[_-]?\w*\s*[:=]\s*['"]?[A-Za-z0-9+/\-_]{16,}['"]?/gi,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9+/\-_.]{20,}/gi,
  // AWS-style access keys
  /\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
  // Base64 blobs that look like secrets (≥40 chars of base64)
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

function scrubSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal: build the frontier critic prompt
// ---------------------------------------------------------------------------

const TASTE_SYSTEM_PROMPT = `You are a world-class founder and designer with deep taste — think the intersection of Paul Graham's clarity instincts, Jony Ive's design minimalism, and a 10x engineer's sense of what actually moves the needle. You evaluate software diffs and proposals for genuine quality beyond correctness.

You judge work on three axes:
1. VISION-ALIGNMENT (1–5): Does this advance the tool's stated north-star direction? Score 5 = directly accelerates core mission; Score 1 = tangential or regressive.
2. AMBITION/IMPACT (1–5): Is this a bold, meaningful change or incremental noise? Score 5 = unlocks a capability/experience that wasn't possible; Score 1 = trivial fix or cosmetic.
3. DESIGN TASTE (1–5): Is the implementation clean, minimal, and elegant? Score 5 = exemplary — idiomatic, no cruft, obvious intent; Score 1 = hacky, verbose, or fighting the architecture.

Verdicts:
- 'gold': overall ≥ 4.0 — this is genuinely great work, prioritize it
- 'solid': 2.1–3.9 — competent, ships, not transformative
- 'mediocre': overall ≤ 2.0 — correct but forgettable, deprioritize

Be decisive and honest. Do not be diplomatic about mediocre work. Return ONLY valid JSON — no prose before or after.

Response schema (strict JSON, no markdown):
{
  "alignment": <1–5 integer>,
  "ambition": <1–5 integer>,
  "design": <1–5 integer>,
  "overall": <1–5 float, your holistic judgment — NOT a simple average>,
  "verdict": "gold" | "solid" | "mediocre",
  "rationale": "<1–2 sentences explaining the verdict>"
}`;

function buildUserPrompt(
  proposal: Proposal,
  ctx: TasteContext,
): string {
  const direction = ctx.direction?.trim() ||
    'ashlr-hub: autonomous engineering fleet — maximize substantive autonomous merges per week, engineering hours freed, and the ambition of what the fleet ships.';

  const diffPreview = proposal.diff
    ? scrubSecrets(proposal.diff.slice(0, 3000))
    : '(no diff available)';

  const repoLabel = ctx.repo ?? proposal.repo ?? 'unknown';

  return `TOOL DIRECTION:
${direction}

REPO: ${repoLabel}

PROPOSAL:
Title: ${proposal.title}
Summary: ${scrubSecrets(proposal.summary ?? '')}
Origin: ${proposal.origin}
Kind: ${proposal.kind}

DIFF PREVIEW (first 3000 chars):
${diffPreview}

Score this proposal on the three taste axes and return the JSON verdict.`;
}

// ---------------------------------------------------------------------------
// Internal: parse the frontier response
// ---------------------------------------------------------------------------

function parseResponse(raw: string): TasteScore | null {
  try {
    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const alignment = clampScore(parsed['alignment']);
    const ambition = clampScore(parsed['ambition']);
    const design = clampScore(parsed['design']);
    const overall = clampOverall(parsed['overall']);
    const verdict = parseVerdict(parsed['verdict'], overall);
    const rationale =
      typeof parsed['rationale'] === 'string' && parsed['rationale'].length > 0
        ? parsed['rationale'].slice(0, 500)
        : 'No rationale provided.';

    return { alignment, ambition, design, overall, verdict, rationale };
  } catch {
    return null;
  }
}

function clampScore(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function clampOverall(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n * 10) / 10));
}

function parseVerdict(v: unknown, overall: number): TasteVerdict {
  if (v === 'gold' || v === 'solid' || v === 'mediocre') return v;
  // Derive from overall if verdict field is missing/invalid
  if (overall >= 4.0) return 'gold';
  if (overall <= 2.0) return 'mediocre';
  return 'solid';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score a proposal on the three taste axes using a frontier (Opus) critic.
 *
 * Reuses resolveFrontierJudgeClient from manager.ts for consistent client
 * resolution (Claude CLI → fallback → null).
 *
 * @param proposal The proposal to score (diff + title + summary used).
 * @param ctx      Repo + direction context for vision-alignment judgment.
 * @param cfg      AshlrConfig — used for frontier client resolution.
 * @returns        TasteScore — never throws; returns neutral on any failure.
 */
export async function scoreTaste(
  proposal: Proposal,
  ctx: TasteContext,
  cfg: AshlrConfig,
): Promise<TasteScore> {
  // Resolve the frontier client via the M176 resolver (same as automerge-pass).
  let client: { complete: (system: string, user: string) => Promise<string> } | null = null;
  try {
    const { resolveFrontierJudgeClient } = await import('./manager.js');
    client = resolveFrontierJudgeClient(cfg);
  } catch {
    return neutralScore('Frontier client unavailable (manager.js import failed).');
  }

  if (!client) {
    return neutralScore('No frontier client configured — returning neutral taste score.');
  }

  const userPrompt = buildUserPrompt(proposal, ctx);

  let raw: string;
  try {
    raw = await client.complete(TASTE_SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    return neutralScore(
      `Frontier call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = parseResponse(raw);
  if (!parsed) {
    return neutralScore(`Could not parse frontier response: ${raw.slice(0, 200)}`);
  }

  return parsed;
}
