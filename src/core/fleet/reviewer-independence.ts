import type { Proposal } from '../types.js';
import { agentSemanticModelFamily } from '../learning/agent-semantic-events.js';

export type ReviewModelFamily = ReturnType<typeof agentSemanticModelFamily>;

export interface ReviewerIndependenceVerdict {
  independent: boolean;
  producerFamily: ReviewModelFamily;
  reviewerFamily: ReviewModelFamily;
  reason: string;
}

const REVIEW_ENGINE_FAMILIES: Readonly<Record<string, ReviewModelFamily>> = {
  anthropic: 'claude',
  claude: 'claude',
  codex: 'openai',
  openai: 'openai',
  local: 'local',
  'local-coder': 'local',
  builtin: 'local',
  ashlrcode: 'local',
  aw: 'local',
  hermes: 'local',
  kimi: 'local',
  nim: 'local',
  ollama: 'local',
  opencode: 'local',
  grok: 'local',
  xai: 'local',
  gemini: 'local',
  mistral: 'local',
  moonshot: 'local',
};

export function reviewModelFamily(value: unknown): ReviewModelFamily {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'unknown';
  const colon = normalized.indexOf(':');
  const slash = normalized.indexOf('/');
  const separator = colon < 0 ? slash : slash < 0 ? colon : Math.min(colon, slash);
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
  const colon = normalized.indexOf(':');
  const slash = normalized.indexOf('/');
  const separator = colon < 0 ? slash : slash < 0 ? colon : Math.min(colon, slash);
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
