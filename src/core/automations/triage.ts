/**
 * Automation triage — "should this be worked, on which lane, with which
 * playbook?" — asked of the Jev decision layer ONCE per new firing (never
 * for a deduped event, never on a dry run), confidence-gated, with the
 * automation's own configuration as the deterministic answer
 * (docs/JEV-INTEGRATION.md rules 1–5).
 *
 * `AutomationDecider` is the seam. Today's default speaks to Jev through the
 * existing typed client (classify/typesafe-client.ts: one call, all three
 * questions, no retries, never throws). When the shared decision layer
 * (src/core/decide, `decide(...)`) lands, it replaces `defaultAutomationDecider`
 * with a same-shape adapter and nothing else here changes.
 *
 * What triage may do — and nothing more:
 *   - pick a lane from `triage.lanes` (the operator's allow-list, which
 *     always contains the configured lane) when confident;
 *   - pick a playbook from `triage.playbooks` when confident;
 *   - ESCALATE: when Jev is confident the item is not worth working
 *     (P(worth) < AUTOMATION_TRIAGE_DOUBT), route it to leader-review so a
 *     human decides. It can never drop work, never choose a lane outside the
 *     allow-list, and never touch a gate.
 */
import {
  AUTOMATION_TRIAGE_DOUBT,
  type AutomationLane,
  type AutomationTriageRecord,
  type AutomationV1,
} from './types.js';

export interface AutomationTriageInput {
  /** The text classified: title + untrusted event body (capped). */
  state: string;
  lanes: readonly AutomationLane[];
  playbooks: readonly string[];
}

export interface AutomationTriageAnswer {
  /** P(this is a concrete task worth an autonomous agent's time), or null. */
  worth: number | null;
  lane: { choice: AutomationLane; confidence: number } | null;
  playbook: { choice: string; confidence: number } | null;
}

/** Null (or a throw) = unavailable → the rules path. */
export type AutomationDecider = (input: AutomationTriageInput) => Promise<AutomationTriageAnswer | { unavailable: string } | null>;

export interface TriageOutcome {
  lane: AutomationLane;
  playbookId: string | null;
  record: AutomationTriageRecord;
}

const STATE_MAX_CHARS = 6_000;
const NO_PLAYBOOK = 'none';

const LANE_CRITERIA: Record<AutomationLane, string> = {
  fleet: 'small, well-scoped change (a bug fix, a test, a dependency bump) the local fleet can finish in one pass under tight size caps',
  cloud: 'medium task that needs a full coding session with the repository checked out (Claude cloud session)',
  devin: 'larger or long-running task that benefits from an autonomous engineer working for an hour or more (Devin session)',
  'leader-review': 'ambiguous, risky, product-level or unclear request that a human should look at before any work starts',
};

/** Default decider: Jev via the typed client. Lazy imports keep this module free of network code. */
export const defaultAutomationDecider: AutomationDecider = async (input) => {
  const [{ askTypeSafe, choiceAnswer, noulAnswer }, { loadConfigReadOnly }] = await Promise.all([
    import('../classify/typesafe-client.js'),
    import('../config.js'),
  ]);
  const questions: Record<string, import('../classify/typesafe-client.js').TypeSafeQuestion> = {
    worth: {
      type: 'noul',
      instructions: 'Is this a concrete, actionable software engineering task that an autonomous coding agent should work on (not spam, not a question, not a discussion)?',
    },
  };
  if (input.lanes.length > 1) {
    questions['lane'] = {
      type: 'choice',
      instructions: 'Which lane should handle this task?',
      criteria: Object.fromEntries(input.lanes.map((l) => [l, LANE_CRITERIA[l]])),
    };
  }
  if (input.playbooks.length > 0) {
    questions['playbook'] = {
      type: 'choice',
      instructions: 'Which playbook (a named procedure) fits this task best, if any?',
      criteria: Object.fromEntries([...input.playbooks.map((p) => [p, `the task matches the "${p}" playbook`]), [NO_PLAYBOOK, 'none of the playbooks fits']]),
    };
  }
  const result = await askTypeSafe({ state: input.state.slice(0, STATE_MAX_CHARS), questions, model: 'jev-latest' }, loadConfigReadOnly(), { timeoutMs: 8_000 });
  if (!result.ok) return { unavailable: result.reason };
  const worth = noulAnswer(result, 'worth');
  const lane = input.lanes.length > 1 ? choiceAnswer(result, 'lane', input.lanes) : undefined;
  const playbook = input.playbooks.length > 0 ? choiceAnswer(result, 'playbook', [...input.playbooks, NO_PLAYBOOK]) : undefined;
  return {
    worth: worth ? worth.noul : null,
    lane: lane ? { choice: lane.choice, confidence: lane.confidence } : null,
    playbook: playbook && playbook.choice !== NO_PLAYBOOK ? { choice: playbook.choice, confidence: playbook.confidence } : null,
  };
};

function rules(automation: AutomationV1, note: string): TriageOutcome {
  return { lane: automation.lane, playbookId: automation.playbookId, record: { source: 'rules', confidence: null, worth: null, note } };
}

const pct = (n: number): string => n.toFixed(2);

/**
 * Decide lane + playbook for one new firing. NEVER THROWS; the rules path
 * (the automation's own lane and playbook) is the answer whenever triage is
 * off, the decider is unavailable, or it is not confident enough.
 */
export async function triageFiring(
  automation: AutomationV1,
  event: { title: string; text: string },
  decider: AutomationDecider | null,
): Promise<TriageOutcome> {
  const config = automation.triage;
  if (!config) return rules(automation, 'rules: triage is off for this automation');
  if (!decider) return rules(automation, 'rules: no decider in this process');
  let answer: Awaited<ReturnType<AutomationDecider>>;
  try {
    answer = await decider({ state: `${event.title}\n\n${event.text}`, lanes: config.lanes, playbooks: config.playbooks });
  } catch {
    answer = null;
  }
  if (!answer) return rules(automation, 'rules: Jev unavailable');
  if ('unavailable' in answer) return rules(automation, `rules: Jev unavailable (${answer.unavailable})`);

  const min = config.minConfidence;
  // Escalate only: a confident "not worth it" goes to a human, never to the bin.
  if (answer.worth !== null && answer.worth < AUTOMATION_TRIAGE_DOUBT && (1 - answer.worth) >= min) {
    return {
      lane: 'leader-review',
      playbookId: automation.playbookId,
      record: { source: 'jev', confidence: 1 - answer.worth, worth: answer.worth, note: `Jev doubts this is actionable (P=${pct(answer.worth)}) — held for review` },
    };
  }
  let lane = automation.lane;
  let laneNote = `lane ${lane} (configured)`;
  let confidence: number | null = null;
  if (answer.lane && config.lanes.includes(answer.lane.choice)) {
    if (answer.lane.confidence >= min) {
      lane = answer.lane.choice;
      confidence = answer.lane.confidence;
      laneNote = `Jev picked ${lane} at ${pct(confidence)}`;
    } else {
      laneNote = `Jev leaned ${answer.lane.choice} at ${pct(answer.lane.confidence)} (< ${pct(min)}), kept ${lane}`;
    }
  }
  let playbookId = automation.playbookId;
  let playbookNote = '';
  if (answer.playbook && config.playbooks.includes(answer.playbook.choice) && answer.playbook.confidence >= min) {
    playbookId = answer.playbook.choice;
    playbookNote = `; playbook ${playbookId} at ${pct(answer.playbook.confidence)}`;
  }
  const source = confidence !== null || playbookId !== automation.playbookId ? 'jev' : 'rules';
  return { lane, playbookId, record: { source, confidence, worth: answer.worth, note: `${laneNote}${playbookNote}` } };
}
