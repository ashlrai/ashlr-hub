/**
 * decide/registry.ts — every decision kind Jev may help with, its label
 * vocabulary, default confidence gate, and whether it sits next to a safety
 * gate. ONE schema per decision, so every call site asks the same question the
 * same way and the ledger rolls up cleanly.
 *
 * THRESHOLDS. 0.75 is the project-wide "confident enough to act" line (see
 * ENGINE_ERROR_CONFIDENCE_THRESHOLD for the measured derivation: a 0.75 top
 * label carries 3x the mass of everything else combined, and the measured
 * ambiguous case sat at 0.57). Kinds go HIGHER, never lower, when a wrong
 * answer is costlier than a missed one:
 *   - judge / taste extraction 0.9: the extracted verdict feeds merge
 *     eligibility; a wrong 'ship' is expensive, a missed one costs a reprompt.
 *   - operator intent 0.8: a mis-routed message is visible to Mason.
 *   - trigger triage / lane choice 0.8: they commit spend.
 *   - action-class 0.85: advisory only, but a noisy advisor gets ignored.
 */

import type { DecisionKind, DecisionKindSpec } from './types.js';

/** Unified task-class vocabulary (see task-class.ts for the projections). */
export const TASK_CLASSES = [
  'bug-fix',
  'feature',
  'refactor',
  'tests',
  'docs',
  'deps',
  'ci',
  'revert',
  'performance',
  'security',
  'type-lint',
  'other',
] as const;

export const OPERATOR_INTENTS = [
  'status-request',
  'directive',
  'answer',
  'approval',
  'veto',
  'task-request',
  'chit-chat',
] as const;

export const WORK_LANES = ['fleet', 'cloud', 'devin', 'interactive'] as const;

export const NEEDS_YOU_PRIORITIES = ['now', 'today', 'this-week', 'whenever'] as const;

export const ACTION_CLASSES = ['A', 'B', 'C'] as const;

export const JUDGE_VERDICTS = ['ship', 'review', 'noise', 'harmful'] as const;
export const TASTE_VERDICTS = ['gold', 'solid', 'mediocre'] as const;
export const RED_TEAM_SEVERITIES = ['high', 'medium', 'low', 'none'] as const;

/** Root-cause CATEGORIES for retros whose deterministic code is generic. */
export const RETRO_ROOT_CAUSES = [
  'test-failure',
  'type-error',
  'lint-failure',
  'build-failure',
  'flaky-or-infra',
  'timeout',
  'auth-or-quota',
  'stale-base',
  'scope-too-large',
  'wrong-approach',
  'missing-context',
  'no-change-needed',
  'unwanted',
  'other',
] as const;

export const ENGINE_ERROR_LABELS = [
  'authentication',
  'configuration',
  'command-missing',
  'rate-limit',
  'timeout',
  'terminated',
  'mcp-downstream',
  'model-failure',
  'execution',
] as const;

export const COMPLETION_CLAIMS = ['claims-change', 'reports-blocked', 'answers-only', 'unknown'] as const;

const spec = (s: DecisionKindSpec): DecisionKindSpec => s;

export const DECISION_KINDS: Readonly<Record<DecisionKind, DecisionKindSpec>> = {
  'engine-error': spec({
    kind: 'engine-error',
    description: 'Engine stderr → one error kind + a retryability Noul (agent-diagnostics + self-heal, unified).',
    primary: 'error_kind',
    labels: ENGINE_ERROR_LABELS,
    threshold: 0.75,
    timeoutMs: 8_000,
    safetyAdjacent: false,
    callSites: ['src/core/classify/engine-errors.ts classifyEngineError', 'src/core/run/sandboxed-engine.ts'],
  }),
  'task-class': spec({
    kind: 'task-class',
    description: 'Proposal/goal/retro text → one unified task class, projected onto each legacy vocabulary.',
    primary: 'task_class',
    labels: TASK_CLASSES,
    threshold: 0.75,
    timeoutMs: 8_000,
    safetyAdjacent: false,
    callSites: [
      'src/core/fleet/skill-library.ts deriveTaskClass',
      'src/core/learn/reflect.ts classifyGoal',
      'src/core/learn/retro/inject.ts classifyTaskKind',
    ],
  }),
  'judge-verdict': spec({
    kind: 'judge-verdict',
    description: 'Unparseable judge output → the verdict + four 1-5 dimensions the judge stated (extraction, not judgement).',
    primary: 'verdict',
    labels: JUDGE_VERDICTS,
    threshold: 0.9,
    timeoutMs: 8_000,
    safetyAdjacent: true,
    callSites: ['src/core/fleet/manager.ts judgeRubricFromModel'],
  }),
  'taste-verdict': spec({
    kind: 'taste-verdict',
    description: 'Unparseable/verdict-less taste critic output → gold/solid/mediocre + three 1-5 axes.',
    primary: 'verdict',
    labels: TASTE_VERDICTS,
    threshold: 0.9,
    timeoutMs: 8_000,
    safetyAdjacent: false,
    callSites: ['src/core/fleet/taste-critic.ts scoreTaste'],
  }),
  'red-team-verdict': spec({
    kind: 'red-team-verdict',
    description: 'Unparseable red-team output → the most severe finding it reports (escalate-only: can only add a finding).',
    primary: 'severity',
    labels: RED_TEAM_SEVERITIES,
    threshold: 0.85,
    timeoutMs: 8_000,
    safetyAdjacent: true,
    callSites: ['src/core/fleet/red-team.ts redTeamProposal'],
  }),
  'completion-claim': spec({
    kind: 'completion-claim',
    description: "An agent's closing message → what it claims about work performed.",
    primary: 'claim',
    labels: COMPLETION_CLAIMS,
    threshold: 0.75,
    timeoutMs: 8_000,
    safetyAdjacent: false,
    callSites: ['src/core/classify/completion-claims.ts classifyCompletionClaim'],
  }),
  'retro-root-cause': spec({
    kind: 'retro-root-cause',
    description: 'A retro with a generic root-cause code → a root-cause category from its free-text detail.',
    primary: 'root_cause',
    labels: RETRO_ROOT_CAUSES,
    threshold: 0.75,
    timeoutMs: 8_000,
    safetyAdjacent: false,
    callSites: ['src/core/learn/retro/sweep.ts sweepRetros'],
  }),
  'needs-you-priority': spec({
    kind: 'needs-you-priority',
    description: 'Needs-you items → urgency buckets (reorders within a severity band only).',
    primary: 'priority',
    labels: NEEDS_YOU_PRIORITIES,
    threshold: 0.75,
    timeoutMs: 6_000,
    safetyAdjacent: false,
    callSites: ['src/core/verse/activity.ts (within-severity ordering)', 'exported: prioritizeNeedsYou'],
  }),
  'interrupt-worthiness': spec({
    kind: 'interrupt-worthiness',
    description: '"Worth interrupting Mason now?" for a push (never suppresses a high/blocking item).',
    primary: 'interrupt',
    labels: [],
    threshold: 0.8,
    timeoutMs: 4_000,
    safetyAdjacent: false,
    callSites: ['exported: worthInterrupting (Leader/Telegram)'],
  }),
  'lane-choice': spec({
    kind: 'lane-choice',
    description: 'A task → fleet | cloud | devin | interactive, among the lanes available now.',
    primary: 'lane',
    labels: WORK_LANES,
    threshold: 0.8,
    timeoutMs: 6_000,
    safetyAdjacent: false,
    callSites: ['exported: chooseLane (Devin fleet, orchestration)'],
  }),
  'trigger-triage': spec({
    kind: 'trigger-triage',
    description: 'An automation trigger (issue, CI failure, alert) → work it? which lane? which playbook?',
    primary: 'lane',
    labels: [],
    threshold: 0.8,
    timeoutMs: 6_000,
    safetyAdjacent: false,
    callSites: ['exported: triageTrigger (automations)'],
  }),
  'action-class': spec({
    kind: 'action-class',
    description: 'Leader action → A/B/C SUGGESTION only; the authority class stays deterministic (escalate-only).',
    primary: 'action_class',
    labels: ACTION_CLASSES,
    threshold: 0.85,
    timeoutMs: 6_000,
    safetyAdjacent: true,
    callSites: ['vision/leader-advice.ts: suggestActionClass after enactment (Leader memo label only)'],
  }),
  'operator-intent': spec({
    kind: 'operator-intent',
    description: "Mason's message → status-request | directive | answer | approval | veto | task-request | chit-chat.",
    primary: 'intent',
    labels: OPERATOR_INTENTS,
    threshold: 0.8,
    timeoutMs: 4_000,
    safetyAdjacent: true,
    callSites: ['exported: classifyOperatorIntent (Leader/Telegram)'],
  }),
};

export const ALL_DECISION_KINDS: readonly DecisionKind[] = Object.keys(DECISION_KINDS) as DecisionKind[];

export function isDecisionKind(value: unknown): value is DecisionKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DECISION_KINDS, value);
}
