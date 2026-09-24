import type { Proposal } from '../types.js';
import type { FleetEngine, JudgeId } from './fleet-types.js';
import { agentSemanticModelFamily } from '../learning/agent-semantic-events.js';

export type ReviewModelFamily = ReturnType<typeof agentSemanticModelFamily>;

export interface ReviewerIndependenceVerdict {
  independent: boolean;
  producerFamily: ReviewModelFamily;
  reviewerFamily: ReviewModelFamily;
  reason: string;
}

/**
 * Engine prefix → provider family. A composite id (`<engine>:<model>` or
 * `<engine>/<model>`) takes its family from the ENGINE; the model suffix may
 * refine it but never contradict it (see reviewModelFamily).
 *
 * V3.10 (SPEC-310B §3):
 *  - `grok`, `xai` and the new `grok-cli` seat engine are the `xai` family.
 *    They were filed under `local`, which made a Grok producer and a local
 *    judge "the same family" — the opposite of the fleet's judging plan
 *    (local work → Grok judge; Grok work → Claude judge).
 *  - `claude-cli` (the FleetEngine spelling) is `claude`.
 *  - `llama-server` is `local`. It was missing, so a proposal produced on the
 *    parallel local lane (`llama-server:<tag>`) classified as `unknown` and
 *    reviewer independence was denied for every one of them.
 */
const REVIEW_ENGINE_FAMILIES: Readonly<Record<string, ReviewModelFamily>> = {
  anthropic: 'claude',
  claude: 'claude',
  'claude-cli': 'claude',
  codex: 'openai',
  openai: 'openai',
  grok: 'xai',
  'grok-cli': 'xai',
  xai: 'xai',
  local: 'local',
  'local-coder': 'local',
  'llama-server': 'local',
  builtin: 'local',
  ashlrcode: 'local',
  aw: 'local',
  hermes: 'local',
  kimi: 'local',
  nim: 'local',
  ollama: 'local',
  opencode: 'local',
  gemini: 'local',
  mistral: 'local',
  moonshot: 'local',
  moonshotai: 'local',
};

/** Index of the first `:` or `/` (the engine/model separator), or -1. */
function separatorIndex(normalized: string): number {
  const colon = normalized.indexOf(':');
  const slash = normalized.indexOf('/');
  return colon < 0 ? slash : slash < 0 ? colon : Math.min(colon, slash);
}

export function reviewModelFamily(value: unknown): ReviewModelFamily {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'unknown';
  const separator = separatorIndex(normalized);
  if (separator < 1) return agentSemanticModelFamily(normalized);

  const engineFamily = REVIEW_ENGINE_FAMILIES[normalized.slice(0, separator)];
  if (!engineFamily) return 'unknown';
  const modelFamily = agentSemanticModelFamily(normalized.slice(separator + 1));
  if (modelFamily !== 'unknown' && modelFamily !== engineFamily) return 'unknown';
  return engineFamily;
}

/**
 * Classify signed proposal identity from its execution-engine prefix. A model
 * suffix may refine that identity, but may never contradict it. Unknown
 * composite prefixes fail closed instead of borrowing authority from a suffix.
 */
export function producerModelFamily(value: unknown): ReviewModelFamily {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'unknown';
  const separator = separatorIndex(normalized);
  if (separator < 1) return reviewModelFamily(normalized);

  const engine = normalized.slice(0, separator);
  const engineFamily = REVIEW_ENGINE_FAMILIES[engine];
  if (!engineFamily) return 'unknown';

  const model = normalized.slice(separator + 1);
  const modelFamily = reviewModelFamily(model);
  if (modelFamily !== 'unknown' && modelFamily !== engineFamily) return 'unknown';
  return engineFamily;
}

export function evaluateReviewerIndependence(
  proposalOrEngineModel: Pick<Proposal, 'engineModel'> | string | null | undefined,
  reviewerModel: unknown,
): ReviewerIndependenceVerdict {
  const producerModel = typeof proposalOrEngineModel === 'string' || proposalOrEngineModel == null
    ? proposalOrEngineModel
    : proposalOrEngineModel.engineModel;
  const producerFamily = producerModelFamily(producerModel);
  const reviewerFamily = reviewModelFamily(reviewerModel);
  if (producerFamily === 'unknown') {
    return {
      independent: false,
      producerFamily,
      reviewerFamily,
      reason: 'reviewer independence denied: signed producer family is unknown',
    };
  }
  if (reviewerFamily === 'unknown') {
    return {
      independent: false,
      producerFamily,
      reviewerFamily,
      reason: 'reviewer independence denied: reviewer family is unknown',
    };
  }
  if (producerFamily === reviewerFamily) {
    return {
      independent: false,
      producerFamily,
      reviewerFamily,
      reason: `reviewer independence denied: producer and reviewer are both ${producerFamily} family`,
    };
  }
  return {
    independent: true,
    producerFamily,
    reviewerFamily,
    reason: `reviewer independence proven: ${producerFamily} producer and ${reviewerFamily} reviewer`,
  };
}

// ---------------------------------------------------------------------------
// V3.10 — frontier judges (SPEC-310B §3 "Judge families", gate G6)
// ---------------------------------------------------------------------------

/** The judge-id prefix that is the ONLY accepted route for an xAI judge. */
export const GROK_CLI_JUDGE_ENGINE = 'grok-cli';

/**
 * A Grok model id as the grok-a seat's own catalog spells it
 * (`<GROK_HOME>/models_cache.json` on 0.2.118: grok-4.7, grok-4.7-build-fast,
 * grok-4.6, grok-4.5). Anything else under the grok-cli prefix is refused.
 */
const GROK_JUDGE_MODEL_RE = /^grok-\d+(?:\.\d+)*(?:-[a-z0-9]+)*$/;

const CLAUDE_JUDGE_ENGINES: ReadonlySet<string> = new Set(['claude', 'claude-cli', 'anthropic']);
const OPENAI_JUDGE_ENGINES: ReadonlySet<string> = new Set(['codex', 'openai']);

function isOpenAiFrontierModel(model: string): boolean {
  // gpt-4* is intentionally excluded (gpt-4-mini etc. are not frontier-tier judges).
  return model.startsWith('gpt-5') || model.startsWith('codex-') || model === 'codex';
}

/**
 * Is this recorded judge identity a frontier judge whose `ship` may carry
 * merge authority? THE rule; `inbox/merge.ts isFrontierJudge` and the manager's
 * attestation signer should both delegate here so the two cannot drift.
 *
 * Accepted:
 *  - Claude: a bare `claude…` id (the legacy recorded form, e.g.
 *    `claude-opus-4-8`) or `claude|claude-cli|anthropic` + a claude-family model.
 *  - OpenAI: a bare `gpt-5…` / `codex-…` / `codex` id, or `codex|openai` + one.
 *  - xAI: ONLY `grok-cli:<grok model>` — the SuperGrok seat engine, run through
 *    the grok-a native profile with its tools disabled (engine-registry
 *    `buildGrokCliHeadlessCommand`).
 *
 * Refused (fail closed):
 *  - Every other xAI spelling: bare `grok-4.7`, `grok:…` (the per-token API
 *    engine), `xai:…`. This REVERSES engine-registry's "grok is never merge
 *    authority" (the api-model entry, M298) FOR JUDGING ONLY, and only for the
 *    seat route — the per-token API engine stays out of both merging and
 *    judging. Mason must review this reversal.
 *  - Any other engine prefix, even one whose model name contains `claude`
 *    (`local-coder:claude-distill`): a local runtime serving a model named
 *    after a vendor is still a local judge.
 *  - `local`, `unknown`, empty, non-strings.
 */
export function isFrontierJudgeId(judgeEngine: unknown): boolean {
  if (typeof judgeEngine !== 'string') return false;
  const lc = judgeEngine.trim().toLowerCase();
  if (!lc || lc === 'unknown' || lc === 'local') return false;
  const separator = separatorIndex(lc);
  if (separator > 0) {
    const engine = lc.slice(0, separator);
    const model = lc.slice(separator + 1);
    if (!model) return false;
    if (engine === GROK_CLI_JUDGE_ENGINE) {
      return lc[separator] === ':' && GROK_JUDGE_MODEL_RE.test(model) && agentSemanticModelFamily(model) === 'xai';
    }
    if (CLAUDE_JUDGE_ENGINES.has(engine)) return agentSemanticModelFamily(model) === 'claude';
    if (OPENAI_JUDGE_ENGINES.has(engine)) return isOpenAiFrontierModel(model);
    return false;
  }
  // Bare ids: the legacy recorded forms. A bare Grok id is never accepted — it
  // could be the per-token API engine, an Ollama tag, or a relabelled local run.
  if (agentSemanticModelFamily(lc) === 'xai') return false;
  if (lc.startsWith('claude') || lc.includes('claude')) return true;
  return isOpenAiFrontierModel(lc);
}

/** `<engine>:<model>` (SPEC-310B §7 naming). */
export function judgeIdFor(engine: FleetEngine | string, model: string): JudgeId {
  return `${engine}:${model}` as JudgeId;
}

export interface JudgeEligibility {
  eligible: boolean;
  frontier: boolean;
  independence: ReviewerIndependenceVerdict;
  reason: string;
}

/**
 * G6 in one call: may `judgeId` judge work signed as `producerModel`? It must
 * be a frontier judge (isFrontierJudgeId) AND of a different, known family
 * (evaluateReviewerIndependence). A local or same-family judge is never
 * eligible — there is no fallback that relaxes either half.
 */
export function evaluateJudgeEligibility(
  producerModel: Pick<Proposal, 'engineModel'> | string | null | undefined,
  judgeId: unknown,
): JudgeEligibility {
  const independence = evaluateReviewerIndependence(producerModel, judgeId);
  const frontier = isFrontierJudgeId(judgeId);
  if (!frontier) {
    return { eligible: false, frontier, independence, reason: 'judge refused: not a frontier judge (a local, unknown or non-seat xAI judge never attests)' };
  }
  if (!independence.independent) return { eligible: false, frontier, independence, reason: `judge refused: ${independence.reason}` };
  return { eligible: true, frontier, independence, reason: independence.reason };
}

/**
 * Which judge lanes to try, in order, for work from `producerFamily`
 * (SPEC-310B §2 G6 / §3):
 *  - local → grok-cli first (Grok judges local work), then Claude, then Codex;
 *  - xai   → the claude-a slice, then Codex (never Grok itself);
 *  - claude→ Codex, then grok-cli;
 *  - openai→ Claude, then grok-cli.
 * Same-family and local lanes are never listed; `unknown` gets nothing.
 * Seat headroom and the 24 h wait are the router's business — this is only
 * the family preference.
 */
export function judgeLanePreference(producerFamily: ReviewModelFamily): readonly FleetEngine[] {
  switch (producerFamily) {
    case 'local': return ['grok-cli', 'claude-cli', 'codex'];
    case 'xai': return ['claude-cli', 'codex'];
    case 'claude': return ['codex', 'grok-cli'];
    case 'openai': return ['claude-cli', 'grok-cli'];
    default: return [];
  }
}
