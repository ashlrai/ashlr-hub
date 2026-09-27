/**
 * decide/ — "Jev decides": one fast, typed decision layer across Verse.
 *
 * Every Jev (TypeSafe AI System One) decision in the hub goes through
 * `decide()` / `decideEach()`, so every call site gets the same guarantees
 * (docs/JEV-INTEGRATION.md):
 *   - never a hard dependency — a deterministic fallback is always required;
 *   - confidence-gated per kind, with the winning path recorded;
 *   - never on a safety gate — safety-adjacent kinds are advisory or
 *     escalate-only;
 *   - budget-aware — batched questions, an input-hash cache, a daily call
 *     budget, a kill switch (ASHLR_JEV_DISABLE=1 or jev/config.json), and a
 *     ledger of calls, tokens, est. cost and latency.
 *
 * STABLE PUBLIC API (other agents call these; additive changes only):
 *   classifyOperatorIntent(text, context)   Leader / Telegram
 *   worthInterrupting(item, context)        Leader / Telegram pushes
 *   prioritizeNeedsYou(items)               Needs-you ordering
 *   chooseLane(task, context)               Devin fleet / orchestration
 *   triageTrigger(trigger, context)         automations
 *   suggestActionClass(action, class)       Leader memo via vision/leader-advice.ts (advisory, escalate-only)
 *   labelTaskClass(text) / primeTaskClasses orchestration task typing
 *   decide / decideEach                     anything new
 */

export type {
  DecideOptions,
  Decision,
  DecisionFallbackReason,
  DecisionKind,
  DecisionKindSpec,
  DecisionPath,
  DecisionRecord,
  Interpretation,
  JevKindStats,
  JevStatus,
} from './types.js';

export { decide, decideEach, effectiveThreshold, jevReady, MAX_BATCH_ITEMS } from './decide.js';
export type { BatchItem, DecideEachOptions } from './decide.js';

export {
  ACTION_CLASSES,
  ALL_DECISION_KINDS,
  DECISION_KINDS,
  isDecisionKind,
  JUDGE_VERDICTS,
  NEEDS_YOU_PRIORITIES,
  OPERATOR_INTENTS,
  RED_TEAM_SEVERITIES,
  RETRO_ROOT_CAUSES,
  TASK_CLASSES,
  TASTE_VERDICTS,
  WORK_LANES,
} from './registry.js';

export { clearDecisionCache } from './cache.js';
export {
  DEFAULT_DAILY_CALL_BUDGET,
  JEV_DISABLE_ENV,
  jevConfigPath,
  jevLedgerDir,
  readJevConfig,
  readLedger,
} from './ledger.js';
export type { JevConfig } from './ledger.js';
export { jevStatus } from './status.js';

export { classifyOperatorIntent, classifyOperatorIntentHeuristic } from './intent.js';
export type { ClassifyOperatorIntentOptions, OperatorIntent, OperatorIntentContext } from './intent.js';

export { availableLanes, chooseLane, chooseLaneHeuristic } from './lane.js';
export type { ChooseLaneOptions, LaneContext, LaneTask, WorkLane } from './lane.js';

export { automationTriageDecider, triageTrigger, triageTriggerHeuristic } from './triage.js';
export type { TriageContext, TriagePlaybook, TriageTriggerOptions, TriggerInput, TriggerTriage } from './triage.js';

export {
  compareRanked,
  needsYouPriorityHeuristic,
  prioritizeNeedsYou,
  worthInterrupting,
  worthInterruptingHeuristic,
} from './needs-you.js';
export type {
  AttentionItem,
  AttentionSeverity,
  InterruptContext,
  NeedsYouPriority,
  PrioritizeNeedsYouOptions,
  RankedAttentionItem,
  WorthInterruptingOptions,
} from './needs-you.js';

export { isActionClass, suggestActionClass } from './action-class.js';
export type { ActionClass, ActionClassAdvice, ActionForReview, SuggestActionClassOptions } from './action-class.js';

export {
  labelTaskClass,
  peekTaskClass,
  primeTaskClasses,
  taskClassHeuristic,
  toGoalCategory,
  toRetroTaskKind,
  toSkillTaskClass,
} from './task-class.js';
export type { GoalCategory, LabelTaskClassOptions, RetroTaskKind, SkillTaskClass, TaskClass } from './task-class.js';

export { isGenericRootCause, labelRetroRootCauses, rootCauseCategoryHeuristic } from './retro.js';
export type { RetroCauseCategory, RetroCauseLabel, RetroForLabel } from './retro.js';

export { extractJudgeRubric, extractRedTeamSeverity, extractTasteScore } from './verdict.js';
export type { ExtractedJudgeRubric, ExtractedTasteScore } from './verdict.js';
