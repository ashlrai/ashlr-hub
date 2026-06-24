/**
 * planner.ts — M28: deterministic-by-default decomposition of an OBJECTIVE
 * into ordered MILESTONES, and per-milestone spec authoring.
 *
 * SAFETY / DESIGN (see docs/contracts/CONTRACT-M28.md):
 *  - LOCAL-FIRST: decomposeGoal is DETERMINISTIC by default (a heuristic split
 *    — NO LLM, ZERO network). Optional LLM-assisted refinement routes ONLY
 *    through getActiveClient(cfg, { allowCloud }) — local Ollama/LM Studio
 *    unless --allow-cloud + a configured key (mirrors M25/M26/M27). The default
 *    path makes ZERO non-localhost connections.
 *  - BOUNDED: the number of milestones is hard-capped by maxMilestones.
 *  - NO OUTWARD ACTION: planning NEVER runs a swarm, NEVER touches a user repo
 *    working tree, NEVER pushes/PRs/deploys. planMilestoneSpec authors a spec
 *    via spec-store (writes ONLY under the spec store, never a user tree).
 *  - No new runtime deps; node builtins + existing modules only.
 */

import { createHash } from 'node:crypto';
import type {
  AshlrConfig,
  DecomposeOptions,
  EngineId,
  Goal,
  Milestone,
  SpecArtifact,
} from '../types.js';
import { authorSpec } from '../spec/spec-store.js';
import { getActiveClient } from '../run/provider-client.js';
import { engineInstalled } from '../run/engines.js';

/**
 * FIXED stable epoch for decomposed-but-not-yet-persisted milestones. Using a
 * constant (NOT Date.now()) keeps decomposeGoal byte-identical across runs for
 * a given input — the determinism the contract + tests require. The store
 * stamps real timestamps when it materializes a milestone (addMilestone).
 */
const STABLE_EPOCH = '1970-01-01T00:00:00.000Z';

/** Lowercase, hyphenated, alnum-only slug (mirrors the store/spec-store slug). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32)
    .replace(/-$/, '');
}

/**
 * Deterministic, unique-within-the-objective milestone id derived from the
 * order + title (+ a short content hash). Stable across runs; no clock, no
 * randomness. The store replaces this with its own `${goalId}-m<order>` id on
 * persistence — this id only needs to be unique within a single decompose call.
 */
function stableMilestoneId(order: number, title: string): string {
  const hash = createHash('sha256').update(`${order}:${title}`).digest('hex').slice(0, 6);
  const slug = slugify(title) || 'milestone';
  return `m${order}-${slug}-${hash}`;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Hard default cap on milestones produced from one objective. */
const DEFAULT_MAX_MILESTONES = 8;

/** Absolute ceiling regardless of caller-supplied maxMilestones. */
const HARD_MAX_MILESTONES = 16;

/** Standard phase scaffold applied to a single-clause objective (no explicit steps). */
const STANDARD_PHASES: { title: string; detail: string }[] = [
  { title: 'Design', detail: 'Clarify scope, constraints, and acceptance criteria.' },
  { title: 'Implement', detail: 'Build the core functionality to satisfy the objective.' },
  { title: 'Test', detail: 'Add focused tests and verify behavior end-to-end.' },
  { title: 'Document', detail: 'Document the change and update any relevant references.' },
];

// ---------------------------------------------------------------------------
// Frontier engine detection (local CLIs — no cloud key required)
// ---------------------------------------------------------------------------

/** Frontier engine ids in preference order (mirrors router.ts FRONTIER_PREFERENCE). */
const FRONTIER_PREFERENCE: readonly EngineId[] = ['claude', 'codex'];

/**
 * Return the first frontier engine that is BOTH in allowedBackends AND installed
 * on PATH. Returns null when none qualify. Pure + read-only (engineInstalled
 * probes PATH once per call). Never throws.
 */
export function pickFrontierEngine(cfg: AshlrConfig): EngineId | null {
  const allowed = new Set<EngineId>(cfg.foundry?.allowedBackends ?? ['builtin']);
  for (const e of FRONTIER_PREFERENCE) {
    if (allowed.has(e) && engineInstalled(e)) return e;
  }
  return null;
}

/**
 * Decompose an objective into milestone parts using a FRONTIER engine CLI
 * (claude/codex) when one is allowed+installed. Returns a JSON-parsed array
 * of {title, detail} parts on success, or throws on any failure so the caller
 * can fall back to the deterministic split.
 *
 * Uses a minimal runGoal call (maxSteps:3, sandbox:false — planning only,
 * no code edits, no proposals). Parses the finalAnswer with a sane fallback
 * JSON extractor.
 *
 * NEVER runs a swarm against a real repo. NEVER proposes. ZERO disk writes
 * beyond normal run state (~/.ashlr/runs/<id>.json).
 */
async function decomposeWithFrontier(
  objective: string,
  cfg: AshlrConfig,
  cap: number,
): Promise<{ title: string; detail: string }[]> {
  // Lazy import to avoid loading the heavy orchestrator at module-load time.
  const { runGoal } = await import('../run/orchestrator.js');
  const prompt =
    `Decompose this software objective into an ordered list of ${cap} milestones.\n` +
    `Return STRICT JSON only — an array of {"title": string, "detail": string} objects.\n` +
    `No prose, no code fences, no commentary. Exactly ${cap} items or fewer.\n\n` +
    `Objective: ${objective}`;

  const run = await runGoal(prompt, cfg, {
    budget: { maxTokens: 8_000, maxSteps: 3 },
    allowCloud: false,
    noMemory: true,
    tools: false,
  });

  const answer = run.result ?? '';
  if (!answer.trim()) throw new Error('frontier returned empty answer');

  const parsed: unknown = JSON.parse(stripFences(answer));
  if (!Array.isArray(parsed)) throw new Error('frontier did not return an array');

  const parts = parsed
    .filter(
      (x): x is { title: string; detail?: string } =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as { title?: unknown }).title === 'string' &&
        String((x as { title: string }).title).trim().length > 0,
    )
    .map((x) => ({ title: String(x.title).trim(), detail: String(x.detail ?? '').trim() }));

  if (parts.length < 2) throw new Error(`frontier produced only ${parts.length} milestone(s)`);
  return parts;
}

// ---------------------------------------------------------------------------
// decomposeGoal
// ---------------------------------------------------------------------------

/**
 * Decompose a high-level `objective` into an ordered list of Milestones.
 *
 * FRONTIER-FIRST (when a frontier engine is allowed+installed): routes the
 * decomposition to the best available frontier CLI (claude/codex) via runGoal —
 * these engines produce well-structured, actionable plans. Falls back to the
 * deterministic local split on any engine error or garbled output.
 *
 * DEFAULT (local, deterministic): split the objective into a bounded sequence
 * of ordered milestones using a pure heuristic (numbered-list / "then" /
 * sentence segmentation, plus a standard scaffold of phases when the objective
 * is a single clause). NO model is called; ZERO network.
 *
 * OPTIONAL (opts.allowCloud): refine the deterministic split's titles/details
 * via getActiveClient(cfg, { allowCloud }) — local-first; cloud only with a
 * configured key. Refinement NEVER increases the count beyond the cap and
 * falls back to the deterministic split on any model error. This path is NOT
 * taken when a frontier engine already handled decomposition.
 *
 * Returns plain Milestone[] (status 'pending', specId/swarmId/proposalId null,
 * order assigned 0..n). Does NOT persist — the caller (store.addMilestone /
 * the CLI `goals plan`) materializes them. Bounded by
 * min(opts.maxMilestones ?? DEFAULT_MAX_MILESTONES, HARD_MAX_MILESTONES).
 * Never throws.
 */
export async function decomposeGoal(
  objective: string,
  cfg: AshlrConfig,
  opts?: DecomposeOptions,
): Promise<Milestone[]> {
  const cap = Math.max(
    1,
    Math.min(opts?.maxMilestones ?? DEFAULT_MAX_MILESTONES, HARD_MAX_MILESTONES),
  );

  const deterministic = deterministicSplit(objective, cap);
  let parts = deterministic;
  let usedFrontier = false;

  // ── FRONTIER-FIRST: use the best available frontier CLI when installed ──────
  // Local frontier CLIs (claude/codex) produce far better structured plans than
  // the weak local qwen model. No --allow-cloud flag needed — they are local CLIs.
  // Garbled / empty plans fall back to the deterministic split.
  const frontier = pickFrontierEngine(cfg);
  if (frontier) {
    try {
      const frontierParts = await decomposeWithFrontier(objective, cfg, cap);
      // COUNT-GUARD: reject plans that wildly exceed the cap (the frontier may
      // over-decompose). Trim to cap but keep if >= 2 items.
      if (frontierParts.length >= 2 && frontierParts.length <= HARD_MAX_MILESTONES) {
        parts = frontierParts.slice(0, cap);
        usedFrontier = true;
      }
    } catch {
      // Any engine error or parse failure => keep the deterministic split.
      parts = deterministic;
    }
  }

  // ── OPTIONAL local-first refinement (only when frontier didn't already plan) ─
  if (!usedFrontier && opts?.allowCloud) {
    try {
      const refined = await refineWithModel(objective, deterministic, cfg, true);
      // COUNT-PRESERVING: a refinement that changes the milestone count is
      // discarded (we keep the deterministic split). This keeps the plan's
      // shape under the human's control and guards against a hallucinated
      // expansion/collapse.
      parts = refined.length === deterministic.length ? refined : deterministic;
    } catch {
      // Any model error => keep the deterministic split (local-first fallback).
      parts = deterministic;
    }
  }

  return parts.slice(0, cap).map((p, i) => ({
    id: stableMilestoneId(i, p.title),
    title: p.title,
    detail: p.detail,
    order: i,
    status: 'pending' as const,
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: STABLE_EPOCH,
    updatedAt: STABLE_EPOCH,
  }));
}

/**
 * Pure, deterministic, local-only split of an objective into <= cap milestone
 * titles. NO model, NO network. Stable across runs for a given input.
 *
 * Strategy (first that yields >1 segment wins):
 *   1. Numbered / bulleted list items ("1.", "2)", "- ", "* ").
 *   2. Explicit step separators ("then", ";", newline).
 *   3. Sentence boundaries.
 *   4. Single clause => the STANDARD_PHASES scaffold.
 */
function deterministicSplit(
  objective: string,
  cap: number,
): { title: string; detail: string }[] {
  const text = objective.trim();
  if (text.length === 0) {
    return STANDARD_PHASES.slice(0, cap);
  }

  // 1. Numbered / bulleted list items.
  const listItems = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s+/, '').trim())
    .filter((l) => l.length > 0);
  const hadListMarkers = /(?:^|\n)\s*(?:\d+[.)]|[-*])\s+/.test(text);
  if (hadListMarkers && listItems.length > 1) {
    return toParts(listItems, cap);
  }

  // 2. Explicit step separators: " then ", " finally ", " next ", ";", newlines.
  const stepParts = text
    .split(/\s*;\s*|\s+then\s+|\s+finally\s+|\s+next\s+|\r?\n+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (stepParts.length > 1) {
    return toParts(stepParts, cap);
  }

  // 3. Sentence boundaries.
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length > 1) {
    return toParts(sentences, cap);
  }

  // 4. Single clause => standard phase scaffold.
  return STANDARD_PHASES.slice(0, cap);
}

/** Build {title, detail} parts from raw segments: title is the segment trimmed to a short line. */
function toParts(segments: string[], cap: number): { title: string; detail: string }[] {
  return segments.slice(0, cap).map((seg) => {
    const clean = seg.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    const title = clean.length > 72 ? `${clean.slice(0, 69)}...` : clean;
    return { title: title || 'Milestone', detail: clean };
  });
}

/**
 * OPTIONAL refinement of the deterministic split via the active local-first
 * provider. Returns refined parts on success, or throws (the caller falls back
 * to the deterministic split). NEVER increases the count beyond `cap`. The
 * provider chain is local unless allowCloud + a configured key (enforced by
 * getActiveClient itself).
 */
async function refineWithModel(
  objective: string,
  parts: { title: string; detail: string }[],
  cfg: AshlrConfig,
  allowCloud: boolean,
): Promise<{ title: string; detail: string }[]> {
  const client = await getActiveClient(cfg, { allowCloud });
  const sys =
    'You refine a software objective into a concise, ordered list of milestones. ' +
    'Return STRICT JSON: an array of objects {"title": string, "detail": string}. ' +
    `Return EXACTLY ${parts.length} items, in the same order. No prose, no code fences.`;
  const usr =
    `Objective:\n${objective}\n\n` +
    `Current draft milestones (refine titles/details, keep ordering, do not add count):\n` +
    parts.map((p, i) => `${i + 1}. ${p.title} — ${p.detail}`).join('\n');
  const res = await client.chat([
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ]);
  const parsed: unknown = JSON.parse(stripFences(res.content));
  if (!Array.isArray(parsed)) throw new Error('model did not return an array');
  const refined = parsed
    .filter(
      (x): x is { title: string; detail?: string } =>
        typeof x === 'object' && x !== null && typeof (x as { title?: unknown }).title === 'string',
    )
    .map((x) => ({ title: String(x.title), detail: String(x.detail ?? '') }));
  if (refined.length === 0) throw new Error('model returned no usable milestones');
  return refined;
}

/** Strip an accidental ```json fence the model might wrap JSON in. */
function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// planMilestoneSpec
// ---------------------------------------------------------------------------

/**
 * Author (or link) a versioned SpecArtifact for a single milestone of a goal.
 *
 * Delegates to spec-store.authorSpec(goal-derived-prompt, cfg, { project }),
 * which is local-first and idempotent (v1 is reused if it already exists).
 * The authored spec is scoped to the goal's `project` when set. Returns the
 * SpecArtifact so the caller can persist milestone.specId = artifact.id via
 * store.updateMilestoneStatus.
 *
 * NEVER runs a swarm and NEVER touches a user repo working tree — authorSpec
 * only writes to the spec store (project/.ashlr/specs or ~/.ashlr/specs).
 *
 * LOCAL-FIRST: `opts.allowCloud` is threaded straight into authorSpec and
 * defaults to FALSE, so the no-flag `goals plan` path can NEVER reach a cloud
 * provider for spec authoring even when a cloud provider sits in the configured
 * providerChain (closing the default-path cloud-egress gap). Cloud authoring
 * happens ONLY when the user explicitly passed --allow-cloud.
 */
export async function planMilestoneSpec(
  goal: Goal,
  milestone: Milestone,
  cfg: AshlrConfig,
  opts?: { allowCloud?: boolean },
): Promise<SpecArtifact> {
  const goalText = `${goal.objective} — milestone: ${milestone.title}\n${milestone.detail}`;
  return authorSpec(goalText, cfg, {
    ...(goal.project ? { project: goal.project } : {}),
    allowCloud: opts?.allowCloud ?? false,
  });
}
