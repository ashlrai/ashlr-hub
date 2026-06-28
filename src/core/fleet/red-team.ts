/**
 * red-team.ts — M191: adversarial RED-TEAM critic (invented idea #5).
 *
 * Flips the merge gate from "prove this is good" to "TRY TO BREAK IT". A
 * frontier (Opus) reviewer is given a hostile mandate — actively prove the
 * diff is unsafe, wrong, or destructive — while cheap deterministic checks
 * hunt for the obvious failure classes in parallel. A proposal "survives"
 * only if neither the adversary nor the deterministic checks land a
 * high-severity hit.
 *
 * Composition (conceptual — no wiring here):
 *   - phantom   ↔ secret-pattern scan (reuses scrubSecrets patterns)
 *   - binshield ↔ dependency-risk + destructive-diff heuristics
 *   - frontier  ↔ open-ended "how could this fail" adversarial reasoning
 *
 * Build-only: this module is a STANDALONE library. It does NOT touch the
 * merge gate, intake, or any caller — that wiring is a later milestone.
 *
 * Guarantees:
 *   - NEVER throws — on any internal failure it returns a NEUTRAL 'survived'
 *     verdict so it can never false-block a proposal.
 *   - Bounded — diff is truncated before reasoning; attacks are capped.
 *   - Secret-scrubbed — no raw secret reaches the frontier prompt.
 *
 * Flag (default OFF): (cfg.foundry as Record<string, unknown>)['redTeam'].
 *
 * Usage:
 *   import { redTeamProposal } from '../fleet/red-team.js'
 *   const r = await redTeamProposal(proposal, cfg)
 *   if (r.broke) { ...block... }
 */

import type { AshlrConfig, Proposal } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { isDestructiveDiff } from '../run/diff-safety.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AttackSeverity = 'high' | 'medium' | 'low';

/** A single attack the red-teamer attempted. */
export interface RedTeamAttack {
  /** The class of attack — e.g. 'injected-secret', 'destructive-diff', 'frontier-correctness'. */
  vector: string;
  /** What the red-teamer found (1 sentence, scrubbed). */
  finding: string;
  /** How damaging the finding is. A single 'high' breaks the proposal. */
  severity: AttackSeverity;
}

export type RedTeamVerdict = 'survived' | 'broken';

export interface RedTeamResult {
  /** True when at least one HIGH-severity attack landed. */
  broke: boolean;
  /** Every attack the red-teamer attempted that found something. */
  attacks: RedTeamAttack[];
  /** Final verdict — 'broken' iff broke === true. */
  verdict: RedTeamVerdict;
  /** Short human-readable detail (scrubbed). */
  detail: string;
}

/** Options — mostly knobs for bounding + testing. */
export interface RedTeamOptions {
  /** Max chars of diff sent to the frontier (default 4000). */
  maxDiffChars?: number;
  /** Hard cap on returned attacks (default 12). */
  maxAttacks?: number;
}

// ---------------------------------------------------------------------------
// Internal: neutral 'survived' result returned on any failure
// (never false-blocks)
// ---------------------------------------------------------------------------

function survivedNeutral(detail: string, attacks: RedTeamAttack[] = []): RedTeamResult {
  return { broke: false, attacks, verdict: 'survived', detail };
}

// ---------------------------------------------------------------------------
// Adversarial frontier prompt
// ---------------------------------------------------------------------------

const RED_TEAM_SYSTEM_PROMPT = `You are a HOSTILE security and correctness reviewer on a red team. Your job is NOT to be fair or charitable — it is to BREAK this code change. Assume the author is either careless or adversarial and that the diff WILL ship to production unless you stop it.

Actively try to PROVE this diff is unsafe, wrong, or destructive. Hunt for:
- INJECTED SECRETS or credentials (API keys, tokens, passwords, private keys) hidden in the diff.
- DESTRUCTIVE operations: data loss, file/dir deletion (rm -rf), DROP TABLE, truncation, mass deletion, disabling of safety checks.
- DEPENDENCY RISK: newly added packages (typosquats, unmaintained, suspicious install scripts), pinning to a malicious version, or supply-chain vectors.
- CORRECTNESS FAILURES: off-by-one, unhandled errors, race conditions, broken control flow, security holes (injection, SSRF, path traversal, auth bypass), or behavior that contradicts the stated intent.
- WAYS THIS CHANGE COULD FAIL in the worst plausible case.

Be adversarial and decisive. A change is "broken" if you can land even ONE high-severity attack. Do not invent findings that aren't supported by the diff — but do not give the benefit of the doubt either.

Return ONLY valid JSON — no prose, no markdown fences. Schema:
{
  "attacks": [
    { "vector": "<short attack class>", "finding": "<1 sentence: what you found>", "severity": "high" | "medium" | "low" }
  ],
  "verdict": "broken" | "survived"
}
Use an EMPTY attacks array and verdict "survived" ONLY if you genuinely could not break it.`;

// ---------------------------------------------------------------------------
// Internal: build the adversarial user prompt (bounded + scrubbed)
// ---------------------------------------------------------------------------

function buildUserPrompt(proposal: Proposal, maxDiffChars: number): string {
  const diff = proposal.diff
    ? scrubSecrets(String(proposal.diff).slice(0, maxDiffChars))
    : '(no diff available)';
  const title = scrubSecrets(String(proposal.title ?? ''));
  const summary = scrubSecrets(String(proposal.summary ?? ''));
  const repoLabel = proposal.repo ?? 'unknown';

  return `Attempt to break the following code change.

REPO: ${repoLabel}

STATED INTENT:
Title: ${title}
Summary: ${summary}

DIFF (scrubbed, first ${maxDiffChars} chars):
${diff}

Hunt for injected secrets, destructive operations, dependency risk, and correctness failures. Return the JSON verdict.`;
}

// ---------------------------------------------------------------------------
// Internal: parse the adversarial frontier response into attacks
// ---------------------------------------------------------------------------

function parseFrontierAttacks(raw: string, maxAttacks: number): RedTeamAttack[] {
  try {
    const cleaned = String(raw)
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const rawAttacks = Array.isArray(parsed['attacks']) ? parsed['attacks'] : [];

    const attacks: RedTeamAttack[] = [];
    for (const a of rawAttacks) {
      if (attacks.length >= maxAttacks) break;
      if (!a || typeof a !== 'object') continue;
      const obj = a as Record<string, unknown>;
      const vector =
        typeof obj['vector'] === 'string' && obj['vector'].length > 0
          ? scrubSecrets(obj['vector']).slice(0, 80)
          : 'frontier-finding';
      const finding =
        typeof obj['finding'] === 'string' && obj['finding'].length > 0
          ? scrubSecrets(obj['finding']).slice(0, 300)
          : 'Red-team flagged a concern.';
      const severity = normalizeSeverity(obj['severity']);
      attacks.push({ vector: `frontier:${vector}`, finding, severity });
    }
    return attacks;
  } catch {
    return [];
  }
}

function normalizeSeverity(v: unknown): AttackSeverity {
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  // Conservative default: an unparseable severity from the adversary is treated
  // as medium (a finding exists, but we don't auto-break on it).
  return 'medium';
}

// ---------------------------------------------------------------------------
// Deterministic check 1 — injected-secret scan (phantom-style)
// ---------------------------------------------------------------------------

/**
 * Scan the diff for injected secrets by comparing the raw text against its
 * scrubbed form: if scrubbing changed anything, a secret pattern was present.
 * Only the ADDED (+) lines are considered — the change is what introduces risk.
 */
function scanForInjectedSecrets(diff: string): RedTeamAttack[] {
  const addedLines = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
  if (addedLines.trim().length === 0) return [];

  const scrubbed = scrubSecrets(addedLines);
  if (scrubbed !== addedLines && scrubbed.includes('[REDACTED]')) {
    return [
      {
        vector: 'injected-secret',
        finding: 'Diff additions contain a recognized secret pattern (API key / token / credential).',
        severity: 'high',
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Deterministic check 2 — destructive-diff (reuses M158 isDestructiveDiff)
// ---------------------------------------------------------------------------

function scanForDestructive(diff: string): RedTeamAttack[] {
  const result = isDestructiveDiff(diff);
  if (result.destructive) {
    return [
      {
        vector: 'destructive-diff',
        finding: scrubSecrets(result.reason ?? 'Destructive diff pattern detected.').slice(0, 300),
        severity: 'high',
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Deterministic check 3 — dependency-risk heuristics (binshield-style)
// ---------------------------------------------------------------------------

/** Patterns in added lines that indicate destructive shell / data ops. */
const DESTRUCTIVE_CMD_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+-rf?\b/i, label: 'rm -rf invocation' },
  { re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, label: 'SQL DROP statement' },
  { re: /\bTRUNCATE\s+(TABLE\s+)?\w/i, label: 'SQL TRUNCATE statement' },
  { re: /\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i, label: 'unbounded SQL DELETE (no WHERE)' },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, label: 'fork-bomb pattern' },
  { re: /\bchmod\s+-R?\s*777\b/i, label: 'world-writable chmod 777' },
  { re: /\bcurl\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i, label: 'curl | sh remote-exec' },
];

/** Suspicious package-install patterns (supply-chain risk). */
const DEP_RISK_PATTERNS: Array<{ re: RegExp; label: string; severity: AttackSeverity }> = [
  // npm install of a git/url/tarball dep (bypasses registry vetting)
  {
    re: /["']?[\w@/.-]+["']?\s*:\s*["'](?:git\+|https?:\/\/|github:|file:)/i,
    label: 'dependency pinned to a non-registry source (git/url/file)',
    severity: 'medium',
  },
  // preinstall/postinstall lifecycle scripts (common malware vector)
  {
    re: /["'](?:pre|post)install["']\s*:/i,
    label: 'install lifecycle script added (pre/postinstall)',
    severity: 'medium',
  },
];

function scanForDependencyRisk(diff: string): RedTeamAttack[] {
  const attacks: RedTeamAttack[] = [];
  const addedLines = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  const addedText = addedLines.join('\n');
  if (addedText.trim().length === 0) return attacks;

  for (const { re, label } of DESTRUCTIVE_CMD_PATTERNS) {
    if (re.test(addedText)) {
      attacks.push({
        vector: 'destructive-command',
        finding: `Diff additions introduce a destructive command: ${label}.`,
        severity: 'high',
      });
    }
  }

  for (const { re, label, severity } of DEP_RISK_PATTERNS) {
    if (re.test(addedText)) {
      attacks.push({
        vector: 'dependency-risk',
        finding: `Dependency risk: ${label}.`,
        severity,
      });
    }
  }

  return attacks;
}

// ---------------------------------------------------------------------------
// Internal: run all deterministic checks (pure, never-throws)
// ---------------------------------------------------------------------------

function runDeterministicChecks(diff: string | undefined): RedTeamAttack[] {
  if (!diff || typeof diff !== 'string' || diff.trim().length === 0) return [];
  const attacks: RedTeamAttack[] = [];
  try {
    attacks.push(...scanForInjectedSecrets(diff));
    attacks.push(...scanForDestructive(diff));
    attacks.push(...scanForDependencyRisk(diff));
  } catch {
    // Deterministic checks must never throw — partial results are fine.
  }
  return attacks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the adversarial red-team critic against a proposal.
 *
 * Combines a hostile frontier reviewer (open-ended "break it" reasoning) with
 * cheap deterministic checks (injected-secret scan, destructive-diff reuse,
 * dependency-risk heuristics). The proposal is 'broken' iff at least one
 * HIGH-severity attack lands.
 *
 * NEVER throws — returns a neutral 'survived' verdict on any failure so it can
 * never false-block a proposal. Bounded + secret-scrubbed.
 *
 * @param proposal The proposal to attack (diff + title + summary used).
 * @param cfg       AshlrConfig — frontier client resolution + redTeam flag.
 * @param opts      Bounding knobs (diff size, attack cap).
 */
export async function redTeamProposal(
  proposal: Proposal,
  cfg: AshlrConfig,
  opts?: RedTeamOptions,
): Promise<RedTeamResult> {
  const maxDiffChars = opts?.maxDiffChars ?? 4000;
  const maxAttacks = opts?.maxAttacks ?? 12;

  // ── Deterministic checks always run (cheap, pure, never-throws) ──────────
  const deterministicAttacks = runDeterministicChecks(proposal?.diff);

  // ── Adversarial frontier pass (best-effort; never-throws) ────────────────
  let frontierAttacks: RedTeamAttack[] = [];
  try {
    let client: { complete: (system: string, user: string) => Promise<string> } | null = null;
    try {
      const { resolveFrontierJudgeClient } = await import('./manager.js');
      client = resolveFrontierJudgeClient(cfg);
    } catch {
      client = null;
    }

    if (client) {
      const userPrompt = buildUserPrompt(proposal, maxDiffChars);
      try {
        const raw = await client.complete(RED_TEAM_SYSTEM_PROMPT, userPrompt);
        frontierAttacks = parseFrontierAttacks(raw, maxAttacks);
      } catch {
        // Frontier call failed — fall back to deterministic-only.
        frontierAttacks = [];
      }
    }
  } catch {
    // Any unexpected failure in the frontier path → neutral, deterministic-only.
    frontierAttacks = [];
  }

  // ── Combine + decide ─────────────────────────────────────────────────────
  try {
    const attacks = [...deterministicAttacks, ...frontierAttacks].slice(0, maxAttacks);
    const highHits = attacks.filter((a) => a.severity === 'high');
    const broke = highHits.length > 0;

    const detail = broke
      ? `Red-team BROKE the proposal: ${highHits.length} high-severity attack(s) landed — ${scrubSecrets(highHits.map((a) => a.vector).join(', ')).slice(0, 200)}.`
      : attacks.length > 0
        ? `Red-team failed to break it: ${attacks.length} lower-severity finding(s), none high. Proposal survived.`
        : 'Red-team found no attack vector. Proposal survived.';

    return {
      broke,
      attacks,
      verdict: broke ? 'broken' : 'survived',
      detail,
    };
  } catch {
    // Combine/decision must never throw — neutral survive.
    return survivedNeutral('Red-team encountered an internal error; defaulting to survived (neutral, non-blocking).');
  }
}
