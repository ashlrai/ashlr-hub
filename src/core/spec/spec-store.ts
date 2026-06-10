/**
 * spec-store.ts — M12: First-class versioned END-STATE SPEC artifacts.
 *
 * Specs are markdown documents with a structured sidecar JSON (SpecArtifact).
 * Versioning is NEVER destructive: refining produces v+1, never overwrites.
 *
 * Storage layout:
 *   <project>/.ashlr/specs/<slug>-v<N>.md    ← markdown body
 *   <project>/.ashlr/specs/<slug>-v<N>.json  ← SpecArtifact sidecar
 *
 * When no project is given, defaults to ~/.ashlr/specs (global store).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import type { SpecArtifact, AshlrConfig } from '../types.js';
import { getActiveClient } from '../run/provider-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Char cap for spec body injected into a refinement prompt. */
const REFINE_BODY_CAP = 8_000;

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the specs directory for a given project.
 * - When `project` is given: `<project>/.ashlr/specs`
 * - Otherwise (global): `~/.ashlr/specs`
 * Creates the directory on demand (mkdirSync recursive).
 */
export function specsDir(project?: string): string {
  const dir = project
    ? path.join(project, '.ashlr', 'specs')
    : path.join(os.homedir(), '.ashlr', 'specs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// ID / slug helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable slug from a goal string:
 * lowercase, words joined with hyphens, max 48 chars, alphanumeric + hyphens only.
 */
function slugify(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/-$/, '');
}

/**
 * Generate a stable spec id from a goal. The id is the slug + a short hash
 * so two similar goals don't silently collide.
 */
function generateSpecId(goal: string): string {
  const slug = slugify(goal);
  const hash = crypto
    .createHash('sha256')
    .update(goal)
    .digest('hex')
    .slice(0, 6);
  return `${slug}-${hash}`;
}

// ---------------------------------------------------------------------------
// File-path helpers
// ---------------------------------------------------------------------------

function mdPath(dir: string, id: string, version: number): string {
  return path.join(dir, `${id}-v${version}.md`);
}

function jsonPath(dir: string, id: string, version: number): string {
  return path.join(dir, `${id}-v${version}.json`);
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** Write sidecar JSON atomically (write-then-rename). */
function saveMeta(dir: string, meta: SpecArtifact): void {
  const target = jsonPath(dir, meta.id, meta.version);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

/** Write markdown body atomically. */
function saveBody(filePath: string, body: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Spec listing / loading
// ---------------------------------------------------------------------------

/**
 * List all specs in the given project (or global), returning the NEWEST
 * version of each spec id, sorted by updatedAt descending.
 */
export function listSpecs(project?: string): SpecArtifact[] {
  const dir = specsDir(project);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Collect all .json sidecars → parse → keep highest version per id
  const byId = new Map<string, SpecArtifact>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const meta = JSON.parse(raw) as SpecArtifact;
      if (!meta.id || typeof meta.version !== 'number') continue;
      const existing = byId.get(meta.id);
      if (!existing || meta.version > existing.version) {
        byId.set(meta.id, meta);
      }
    } catch {
      // Corrupt or partial file — skip silently
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => (b.updatedAt > a.updatedAt ? 1 : -1),
  );
}

/**
 * Load the HIGHEST version of a spec by id.
 * Returns `{ meta, body }` or null if not found / unreadable.
 *
 * Search order (highest version across all readable dirs wins):
 *   1. ~/.ashlr/specs           (global store)
 *   2. <cwd>/.ashlr/specs       (project store when run from the project dir)
 *   3. <project>/.ashlr/specs   (explicit --project hint, when given)
 *
 * The optional `project` hint lets `spec show`/`refine` find a project-scoped
 * spec without having to `cd` into the project first (symmetry with new/list).
 */
export function loadSpec(
  id: string,
  project?: string,
): { meta: SpecArtifact; body: string } | null {
  // Try global, cwd, and (when given) the explicit project dir.
  const candidates: string[] = [
    path.join(os.homedir(), '.ashlr', 'specs'),
    path.join(process.cwd(), '.ashlr', 'specs'),
  ];
  if (project) {
    const projDir = path.join(project, '.ashlr', 'specs');
    if (!candidates.includes(projDir)) candidates.push(projDir);
  }

  let best: SpecArtifact | null = null;
  let bestDir = '';

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (!entry.name.startsWith(id + '-v')) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const meta = JSON.parse(raw) as SpecArtifact;
        if (meta.id !== id) continue;
        if (!best || meta.version > best.version) {
          best = meta;
          bestDir = dir;
        }
      } catch {
        // skip
      }
    }
  }

  if (!best) return null;

  const bodyFile = mdPath(bestDir, best.id, best.version);
  let body = '';
  try {
    body = fs.readFileSync(bodyFile, 'utf8');
  } catch {
    return null;
  }
  return { meta: best, body };
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

/** The structured system prompt for spec authoring. */
const SPEC_SYSTEM_PROMPT = `You are an expert software architect and product strategist.
Your task is to draft a structured END-STATE SPEC — a concrete, ambitious, grounded document
describing the DESIRED END STATE of a software project or initiative.

The spec MUST have exactly these sections (use level-2 markdown headings):

## Context
Who is building this, for whom, what problem it solves, current state.

## North Star
A single crisp sentence capturing the ultimate outcome. What does "done" look like?

## Operating Principles
3–6 guiding constraints and values (e.g. local-first, no-runtime-deps, safety-first).

## Pillars
3–5 major capability pillars / feature clusters with brief descriptions.

## Roadmap
Phases (Phase 1, Phase 2, …). Each phase: name, goal, 2–5 key deliverables.
Keep concrete and achievable, not aspirational fluff.

## Verification
How will we know the spec is satisfied? 3–6 measurable acceptance criteria.

RULES:
- Be concrete, specific, and grounded. Avoid vague adjectives.
- No marketing copy. No fluff. Prefer bullet points over prose.
- Keep total length 600–1000 words. Quality over quantity.
- Do NOT include section numbers or table of contents.
- Return ONLY the markdown spec body — no preamble, no postamble.`;

/** Build the user prompt for authoring a new spec. */
function buildAuthorPrompt(goal: string): string {
  return `Draft an end-state spec for the following goal:\n\n> ${goal}\n\nReturn only the structured markdown spec body.`;
}

/** Build the user prompt for refining an existing spec. */
function buildRefinePrompt(
  goal: string,
  version: number,
  body: string,
  note: string,
): string {
  const truncatedBody =
    body.length > REFINE_BODY_CAP ? body.slice(0, REFINE_BODY_CAP) + '\n\n[...truncated]' : body;
  return (
    `You are refining an existing end-state spec (currently v${version}) for the goal:\n\n` +
    `> ${goal}\n\n` +
    `--- CURRENT SPEC ---\n${truncatedBody}\n--- END CURRENT SPEC ---\n\n` +
    `Refinement note / change request:\n> ${note}\n\n` +
    `Produce an improved v${version + 1} of the spec, incorporating the note. ` +
    `Preserve the same six-section structure. Return only the updated markdown spec body.`
  );
}

/**
 * Call the LOCAL-first model to produce a spec body string.
 * Bounded to SPEC_MAX_TOKENS output. Never throws — returns a fallback stub on error.
 */
async function callModel(
  cfg: AshlrConfig,
  systemPrompt: string,
  userPrompt: string,
  allowCloud: boolean,
): Promise<{ content: string; usage: { tokensIn: number; tokensOut: number } }> {
  try {
    const client = await getActiveClient(cfg, { allowCloud });
    const result = await client.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    );
    return {
      content: result.content.trim(),
      usage: result.usage,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Return a stub spec so spec-store never throws to the caller
    const stub = buildStubSpec(userPrompt);
    process.stderr.write(`[spec-store] model call failed (${msg}); returning stub spec\n`);
    return { content: stub, usage: { tokensIn: 0, tokensOut: 0 } };
  }
}

/** Minimal stub spec returned when no model is available. */
function buildStubSpec(hint: string): string {
  return `## Context\n_No model available — fill in context manually._\n\n` +
    `## North Star\n_Define the desired end state here._\n\n` +
    `## Operating Principles\n- Local-first\n- No secrets in logs\n\n` +
    `## Pillars\n- _Pillar 1_\n- _Pillar 2_\n\n` +
    `## Roadmap\n### Phase 1\n- _Deliverable 1_\n\n` +
    `## Verification\n- _Acceptance criterion 1_\n\n` +
    `<!-- hint: ${hint.slice(0, 80)} -->`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Author a new spec from a goal string.
 *
 * Uses the LOCAL-first model provider to draft a structured end-state spec
 * with sections: Context / North Star / Operating Principles / Pillars /
 * Roadmap / Verification. Persists `<slug>-v1.md` + sidecar `<slug>-v1.json`.
 *
 * The model call is BOUNDED (small output budget). Never throws.
 */
export async function authorSpec(
  goal: string,
  cfg: AshlrConfig,
  opts?: { project?: string; allowCloud?: boolean },
): Promise<SpecArtifact> {
  const project = opts?.project ?? null;
  const dir = specsDir(project ?? undefined);

  const id = generateSpecId(goal);
  const version = 1;
  const now = new Date().toISOString();

  // Check if v1 already exists for this id — if so, return it (idempotent)
  const existing = loadSpec(id);
  if (existing && existing.meta.version === 1) {
    return existing.meta;
  }

  // Cloud allowance: when a caller EXPLICITLY passes opts.allowCloud, that
  // decision OVERRIDES the chain-derived heuristic — so a caller (e.g. M28
  // `goals plan` without --allow-cloud) can force local-only even when a cloud
  // provider (anthropic) sits in the default providerChain. Only fall back to
  // the chain heuristic when the caller did not express a preference.
  const allowCloud =
    opts?.allowCloud ??
    (cfg.models?.providerChain ?? []).some((p: string) => !['ollama', 'lmstudio', 'builtin'].includes(p));

  const { content } = await callModel(
    cfg,
    SPEC_SYSTEM_PROMPT,
    buildAuthorPrompt(goal),
    allowCloud,
  );

  const bodyPath = mdPath(dir, id, version);

  const meta: SpecArtifact = {
    id,
    goal,
    version,
    project,
    path: bodyPath,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };

  saveBody(bodyPath, content);
  saveMeta(dir, meta);

  return meta;
}

/**
 * Refine an existing spec by id: reads the current highest version, calls the
 * model with the refinement note, writes v+1 (NEVER destructive — never
 * overwrites prior versions).
 *
 * Returns the new SpecArtifact (v+1). Never throws.
 */
export async function refineSpec(
  id: string,
  note: string,
  cfg: AshlrConfig,
  project?: string,
): Promise<SpecArtifact> {
  const existing = loadSpec(id, project);
  if (!existing) {
    throw new Error(`spec-store: spec not found: ${id}`);
  }

  const { meta: currentMeta, body: currentBody } = existing;
  const nextVersion = currentMeta.version + 1;
  const now = new Date().toISOString();

  const dir = specsDir(currentMeta.project ?? undefined);

  // Determine cloud allowance from config
  const allowCloud =
    (cfg.models?.providerChain ?? []).some((p: string) => !['ollama', 'lmstudio', 'builtin'].includes(p));

  const { content } = await callModel(
    cfg,
    SPEC_SYSTEM_PROMPT,
    buildRefinePrompt(currentMeta.goal, currentMeta.version, currentBody, note),
    allowCloud,
  );

  const bodyPath = mdPath(dir, id, nextVersion);

  const newMeta: SpecArtifact = {
    ...currentMeta,
    version: nextVersion,
    path: bodyPath,
    updatedAt: now,
  };

  saveBody(bodyPath, content);
  saveMeta(dir, newMeta);

  return newMeta;
}
