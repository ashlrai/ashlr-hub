/**
 * playbooks.ts — M26 playbook distillation from SUCCESSFUL past swarms.
 *
 * Distills recurring patterns from `done` swarms into playbook entries and
 * persists them via the genome (appendHubEntry, hubOnly) so they auto-inject
 * into future agents. An OPTIONAL local-model narrative may polish the playbook
 * text — but the default path is deterministic and makes ZERO cloud calls.
 *
 * HARD SAFETY INVARIANTS (M26):
 *  - READ-ONLY over history: reads listSwarms() only. The ONLY write is
 *    appendHubEntry({ hubOnly: true }) into ~/.ashlr/genome/hub.jsonl — an
 *    APPEND to the genome hub. With hubOnly:true it NEVER drops a file into a
 *    user repo working tree (see appendHubEntry's contract). It NEVER writes
 *    CONFIG_PATH / router policy / prompts.
 *  - LOCAL-FIRST: narrative text routes through getActiveClient(cfg,
 *    { allowCloud }) EXACTLY as M25 ask.ts — local Ollama/LM Studio only unless
 *    the caller passes allowCloud AND a key is present. Default path is local
 *    and the deterministic fallback needs no model at all.
 *  - BOUNDED: analyzes at most `maxRuns` recent done swarms; caps emitted
 *    playbooks.
 *  - NEVER THROWS: degrades to the deterministic synthesis / a no-op persist.
 *
 * METADATA ONLY — never persists secret values or raw payloads.
 */

import type { AshlrConfig, GenomeEntry, SwarmRun } from '../types.js';
import { listSwarms } from '../swarm/store.js';
import { appendHubEntry } from '../genome/store.js';
import { getActiveClient } from '../run/provider-client.js';
import { classifyGoal } from './reflect.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Default cap on how many recent swarms to mine for patterns. */
const DEFAULT_MAX_RUNS = 100;

/** Max playbook entries distilled+persisted per invocation. */
const MAX_PLAYBOOKS = 5;

/** Minimum successful swarms in a category before it becomes a playbook. */
const MIN_SUPPORT = 2;

/** Hard cap on the narrative-synthesis prompt fed to the local model (chars). */
const SYNTHESIS_PROMPT_MAX_CHARS = 4000;

// ---------------------------------------------------------------------------
// Types (module-local result shape; report types live in core/types.ts)
// ---------------------------------------------------------------------------

/** One distilled playbook before persistence. */
export interface DistilledPlaybook {
  /** Coarse category / goal-cluster this playbook generalizes. */
  category: string;
  /** Short title used as the genome entry heading. */
  title: string;
  /** The playbook body (deterministic synthesis, optionally LLM-polished). */
  text: string;
  /** Tags attached to the persisted genome entry. */
  tags: string[];
  /** Number of successful swarms that informed this playbook. */
  supportCount: number;
}

/** Result of a distill+persist pass. */
export interface PlaybookResult {
  /** The distilled playbooks (whether or not persistence succeeded). */
  playbooks: DistilledPlaybook[];
  /** Genome entries actually appended (one per persisted playbook). Empty when
   *  persistence was not requested (the default report-only mode). */
  persisted: GenomeEntry[];
  /** True when the narrative text was produced by a LOCAL model (or no model). */
  local: boolean;
  /** Whether the genome hub was actually written (true only with persist:true). */
  didPersist: boolean;
}

// ---------------------------------------------------------------------------
// Pure distillation (exported for testing) — NO I/O, NO LLM
// ---------------------------------------------------------------------------

/** Collapse a result/goal string into a short, single-line excerpt. Pure. */
function excerpt(s: string | undefined, max = 140): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Distill recurring SUCCESSFUL patterns from `done` swarms into playbook
 * candidates. Pure over the provided swarms; never throws.
 *
 * Filters to status==='done', clusters by coarse goal category, and for each
 * cluster with >= MIN_SUPPORT support synthesizes a deterministic "what worked"
 * body from the swarms' goals/results. Capped at MAX_PLAYBOOKS, sorted by
 * supportCount desc.
 */
export function distillPlaybooks(swarms: SwarmRun[]): DistilledPlaybook[] {
  try {
    if (!Array.isArray(swarms)) return [];
    const done = swarms.filter((s) => s && s.status === 'done');
    const byCat = new Map<string, SwarmRun[]>();
    for (const s of done) {
      const cat = classifyGoal(s.goal ?? '');
      const arr = byCat.get(cat) ?? [];
      arr.push(s);
      byCat.set(cat, arr);
    }

    const playbooks: DistilledPlaybook[] = [];
    for (const [category, group] of byCat) {
      if (group.length < MIN_SUPPORT) continue;

      // Deterministic "what worked" body: a few representative goals + outcomes.
      const samples = group.slice(0, 3).map((s) => {
        const goal = excerpt(s.goal, 100) || '(no goal)';
        const seq = phasePattern(s);
        const phaseStr = seq ? ` [phases: ${seq}]` : '';
        const result = excerpt(s.result, 100);
        return `- ${goal}${phaseStr}${result ? ` -> ${result}` : ''}`;
      });

      // The most common phase pattern across the cluster (e.g. "plan -> build").
      const dominant = dominantPhasePattern(group);

      const text =
        `Playbook: ${category} work that succeeded\n\n` +
        `Across ${group.length} successful '${category}' swarm(s), the following approaches ` +
        `completed first-pass. ` +
        (dominant
          ? `The recurring phase pattern was: ${dominant}. `
          : `No consistent phase pattern was recorded. `) +
        `Reuse the phase structure and framing below for similar goals:\n\n` +
        samples.join('\n');

      playbooks.push({
        category,
        title: `What works for ${category} swarms`,
        text,
        tags: ['m26', 'playbook', `cat:${category}`],
        supportCount: group.length,
      });
    }

    playbooks.sort(
      (a, b) =>
        b.supportCount - a.supportCount ||
        (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
    );
    return playbooks.slice(0, MAX_PLAYBOOKS);
  } catch {
    return [];
  }
}

/**
 * Derive a swarm's de-duplicated phase sequence from its executed tasks,
 * rendered as "plan -> build -> verify". Empty string when no phases. Pure.
 */
function phasePattern(s: SwarmRun): string {
  const tasks = Array.isArray(s?.tasks) ? s.tasks : [];
  const phases: string[] = [];
  for (const t of tasks) {
    const ph = t?.phase ? String(t.phase) : '';
    if (ph && phases[phases.length - 1] !== ph) phases.push(ph);
  }
  return phases.join(' -> ');
}

/** The most frequent phase pattern across a cluster of swarms. Pure. */
function dominantPhasePattern(group: SwarmRun[]): string {
  const counts = new Map<string, number>();
  for (const s of group) {
    const ptn = phasePattern(s);
    if (!ptn) continue;
    counts.set(ptn, (counts.get(ptn) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [ptn, n] of counts) {
    if (n > bestN || (n === bestN && (best === '' || ptn < best))) {
      best = ptn;
      bestN = n;
    }
  }
  return best;
}

/**
 * Build the OPTIONAL narrative-synthesis prompt for a playbook candidate.
 * Pure; capped at SYNTHESIS_PROMPT_MAX_CHARS. Never throws.
 */
function buildNarrativePrompt(pb: DistilledPlaybook): string {
  const prompt =
    `You are distilling a reusable engineering playbook from past SUCCESSFUL runs. ` +
    `Rewrite the notes below into a concise, actionable playbook (max ~120 words). ` +
    `Do NOT invent facts; only generalize what is present.\n\n` +
    `Category: ${pb.category}\nSupport: ${pb.supportCount} successful swarm(s)\n\n` +
    `Notes:\n${pb.text}`;
  return prompt.slice(0, SYNTHESIS_PROMPT_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Public: distill + persist
// ---------------------------------------------------------------------------

/**
 * Distill playbooks from recent SUCCESSFUL swarms. Persisting them to the
 * genome hub (appendHubEntry, hubOnly:true) — which auto-injects them into
 * future agents — happens ONLY when `opts.persist` is true. By DEFAULT this is
 * report-only: it distills and returns the playbooks but writes NOTHING, so a
 * genome write that changes future-agent behaviour never happens without an
 * explicit opt-in (the CLI's `--persist` flag).
 *
 * When `opts.narrative` is requested, each playbook body is optionally polished
 * by a model via getActiveClient(cfg, { allowCloud: opts.allowCloud }) —
 * LOCAL-ONLY unless allowCloud AND a key exist (getActiveClient throws
 * otherwise; we then fall back to the deterministic body). The default path
 * (no narrative) makes ZERO non-localhost connections.
 *
 * Never throws. MUST NOT call saveConfig() or write CONFIG_PATH / router policy.
 */
export async function distillAndPersist(
  cfg: AshlrConfig,
  opts: {
    maxRuns?: number;
    narrative?: boolean;
    allowCloud?: boolean;
    /** When true, persist distilled playbooks to the genome hub. Default false
     *  (report-only — no genome write, no future-agent behaviour change). */
    persist?: boolean;
  } = {},
): Promise<PlaybookResult> {
  // 1. Read recent swarms (READ-ONLY, BOUNDED).
  let swarms: SwarmRun[] = [];
  try {
    swarms = listSwarms().slice(0, Math.max(0, opts.maxRuns ?? DEFAULT_MAX_RUNS));
  } catch {
    swarms = [];
  }

  // 2. Deterministic distillation.
  const playbooks = distillPlaybooks(swarms);

  // 3. OPTIONAL narrative polish — LOCAL-FIRST, mirrors M25 ask.ts.
  //    Default path (no narrative) never touches a model at all.
  let local = true;
  if (opts.narrative && playbooks.length > 0) {
    try {
      const client = await getActiveClient(cfg, { allowCloud: opts.allowCloud ?? false });
      // ALLOWLIST (not denylist): only the known local providers count as local.
      local = client.id === 'ollama' || client.id === 'lmstudio';
      for (const pb of playbooks) {
        try {
          const res = await client.chat([
            {
              role: 'system',
              content:
                'You distill reusable engineering playbooks from successful past runs. ' +
                'Be concise and never invent facts.',
            },
            { role: 'user', content: buildNarrativePrompt(pb) },
          ]);
          const polished = (res.content ?? '').trim();
          if (polished) pb.text = polished;
        } catch {
          // Keep the deterministic body for this playbook on any model error.
        }
      }
    } catch {
      // getActiveClient threw (no local provider, or cloud refused without key).
      // Keep deterministic bodies; the local-first refusal is treated as a local
      // attempt that simply didn't produce narrative.
      local = true;
    }
  }

  // 4. Persist each via the genome hub (hubOnly:true => never writes a repo
  //    file) — ONLY when explicitly opted in via persist:true. By default this
  //    is report-only: NO genome write, so future-agent behaviour is unchanged
  //    until a human runs `reflect playbooks --persist`.
  const persisted: GenomeEntry[] = [];
  const didPersist = opts.persist === true;
  if (didPersist) {
    for (const pb of playbooks) {
      try {
        const entry = appendHubEntry({
          text: pb.text,
          title: pb.title,
          tags: pb.tags,
          hubOnly: true,
        });
        persisted.push(entry);
      } catch {
        // Append failed — still return the distilled playbook to the caller.
      }
    }
  }

  return { playbooks, persisted, local, didPersist };
}
