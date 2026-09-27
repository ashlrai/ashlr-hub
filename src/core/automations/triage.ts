/**
 * Automation triage — "should this be worked, on which lane, with which
 * playbook?" — asked of the Jev decision layer ONCE per new firing (never
 * for a deduped event, never on a dry run), confidence-gated, with the
 * automation's own configuration as the deterministic answer
 * (docs/JEV-INTEGRATION.md rules 1–5).
 *
 * `AutomationDecider` is the seam. The default is the shared decision layer's
 * `triageTrigger` (src/core/decide) behind a same-shape adapter: one call,
 * all three questions, never throws.
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
  /** The automation's gate, passed through so the decision ledger records the same threshold. */
  minConfidence?: number;
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
/**
 * Default decider: the shared Jev decision layer's `triageTrigger`
 * (src/core/decide/triage.ts `automationTriageDecider`) — one call, all three
 * questions, through the layer's cache, daily budget, kill switch and ledger.
 * It hands back the raw per-part answers; the gating in `triageFiring` is
 * unchanged. The lazy import keeps this module free of network code.
 */
export const defaultAutomationDecider: AutomationDecider = async (input) =>
  (await import('../decide/triage.js')).automationTriageDecider(input);

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
    answer = await decider({ state: `${event.title}\n\n${event.text}`.slice(0, STATE_MAX_CHARS), lanes: config.lanes, playbooks: config.playbooks, minConfidence: config.minConfidence });
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
