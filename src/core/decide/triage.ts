/**
 * decide/triage.ts — automation trigger triage.
 *
 *   triageTrigger(trigger, context) → { work, lane, playbook }
 *
 * "Should this issue / CI failure / alert be worked? In which lane? With which
 * playbook?" — asked as ONE Jev call with three typed questions (a `work`
 * Noul, a `lane` choice over the available lanes, a `playbook` choice over the
 * caller's playbooks + none). The combined decision is accepted only when
 * every part clears the gate; otherwise the deterministic triage stands whole
 * (never a Frankenstein of half-Jev, half-heuristic).
 *
 * This decides what to PROPOSE. Launching still goes through each lane's own
 * gates (budget, authority, enablement) — triage cannot bypass them.
 */

import type { TypeSafeChoiceQuestion, TypeSafeNoulQuestion } from '../classify/typesafe-client.js';
import { decide } from './decide.js';
import { availableLanes, chooseLaneHeuristic, laneQuestion, type LaneContext, type WorkLane } from './lane.js';
import type { DecideOptions, Decision } from './types.js';

export interface TriggerInput {
  /** 'issue' | 'pr' | 'ci-failure' | 'alert' | 'schedule' | ... */
  readonly source: string;
  readonly title: string;
  readonly body?: string | null;
  readonly labels?: readonly string[];
  readonly repo?: string | null;
  readonly githubRepo?: boolean;
  readonly author?: string | null;
}

export interface TriagePlaybook {
  /** Stable id returned in `playbook`. */
  readonly id: string;
  /** When this playbook applies, in plain words (sent to Jev). */
  readonly when: string;
  /** Deterministic match: any keyword in title/body/labels selects it. */
  readonly keywords?: readonly string[];
}

export interface TriageContext {
  readonly playbooks?: readonly TriagePlaybook[];
  readonly lanes?: LaneContext;
}

export interface TriggerTriage {
  readonly work: boolean;
  readonly lane: WorkLane;
  /** A playbook id from the context, or null for none. */
  readonly playbook: string | null;
  /** Jev's P(worth working), when it answered. */
  readonly workProbability?: number;
}

export type TriageTriggerOptions = Omit<DecideOptions<TriggerTriage>, 'fallback' | 'interpret' | 'escalateOnly'>;

const NON_ENGINEERING_LABELS = /^(question|duplicate|invalid|wontfix|won't fix|discussion|support)$|^ashlr:non-code\//i;
const NOT_WORK_TEXT = /\b(question:|how do i|is it possible|feature request\?|thank you|thanks for)\b/i;
const EPIC_TEXT = /\b(epic|tracking issue|umbrella|meta:|roadmap|milestone|initiative)\b/i;

function findPlaybook(trigger: TriggerInput, playbooks: readonly TriagePlaybook[]): string | null {
  const hay = `${trigger.title}\n${trigger.body ?? ''}\n${(trigger.labels ?? []).join(' ')}`.toLowerCase();
  for (const p of playbooks) {
    if ((p.keywords ?? []).some((k) => k.trim() !== '' && hay.includes(k.toLowerCase()))) return p.id;
  }
  return null;
}

/** Pure, offline, never throws. */
export function triageTriggerHeuristic(trigger: TriggerInput, context: TriageContext = {}): TriggerTriage {
  const labels = trigger.labels ?? [];
  const text = `${trigger.title ?? ''}\n${trigger.body ?? ''}`;
  const nonEngineering = labels.some((l) => NON_ENGINEERING_LABELS.test(l.trim())) || NOT_WORK_TEXT.test(text);
  const epic = EPIC_TEXT.test(text);
  const work = !nonEngineering && !epic && (trigger.title ?? '').trim() !== '';
  const lane = chooseLaneHeuristic(
    {
      title: trigger.title,
      body: trigger.body ?? null,
      labels,
      ...(trigger.repo ? { repo: trigger.repo } : {}),
      ...(trigger.githubRepo !== undefined ? { githubRepo: trigger.githubRepo } : {}),
    },
    context.lanes ?? {},
  );
  return { work, lane, playbook: findPlaybook(trigger, context.playbooks ?? []) };
}

function triggerState(trigger: TriggerInput): string {
  const lines = [`Trigger source: ${trigger.source}`, `Title: ${trigger.title}`];
  if (trigger.repo) lines.push(`Repository: ${trigger.repo}${trigger.githubRepo === false ? ' (local only)' : ''}`);
  if (trigger.labels?.length) lines.push(`Labels: ${trigger.labels.join(', ')}`);
  if (trigger.author) lines.push(`Author: ${trigger.author}`);
  if (trigger.body) lines.push(`Body:\n${trigger.body.slice(0, 3_500)}`);
  return lines.join('\n');
}

/**
 * Triage one automation trigger. NEVER THROWS.
 *
 * STABLE API — the automations agent calls this.
 */
export async function triageTrigger(
  trigger: TriggerInput,
  context: TriageContext = {},
  opts: TriageTriggerOptions = {},
): Promise<Decision<TriggerTriage>> {
  const open = availableLanes(context.lanes ?? {});
  const playbooks = context.playbooks ?? [];
  const playbookIds = playbooks.map((p) => p.id);

  const questions: Record<string, TypeSafeChoiceQuestion | TypeSafeNoulQuestion> = {
    work: {
      type: 'noul',
      instructions:
        'Is this a concrete, actionable engineering task that an autonomous agent should pick up now? '
        + 'Answer no for questions, discussions, duplicates, vague epics, or anything needing a human decision first.',
    },
    lane: laneQuestion(open),
  };
  if (playbooks.length > 0) {
    const criteria: Record<string, string> = { none: 'No listed playbook fits this trigger.' };
    for (const p of playbooks) criteria[p.id] = p.when;
    questions['playbook'] = {
      type: 'choice',
      instructions: 'Which playbook should handle this trigger?',
      criteria,
    };
  }

  return decide<TriggerTriage>('trigger-triage', triggerState(trigger), questions, {
    ...opts,
    fallback: () => triageTriggerHeuristic(trigger, context),
    cacheSalt: JSON.stringify([open, playbooks.map((p) => [p.id, p.when])]),
    interpret: (answers) => {
      const w = answers['work'];
      const l = answers['lane'];
      if (!w || w.type !== 'noul' || !l || l.type !== 'choice' || !open.includes(l.choice as WorkLane)) return undefined;
      let playbook: string | null = null;
      let pConf = 1;
      if (playbooks.length > 0) {
        const p = answers['playbook'];
        if (!p || p.type !== 'choice') return undefined;
        if (p.choice !== 'none' && !playbookIds.includes(p.choice)) return undefined;
        playbook = p.choice === 'none' ? null : p.choice;
        pConf = p.confidence;
      }
      // A Noul is a probability, not a confidence: how far it sits from the
      // coin-flip is how decisive it is.
      const workDecisiveness = Math.max(w.noul, 1 - w.noul);
      const confidence = Math.min(workDecisiveness, l.confidence, pConf);
      const work = w.noul >= 0.5;
      return {
        value: { work, lane: l.choice as WorkLane, playbook, workProbability: w.noul },
        confidence,
        label: `${work ? 'work' : 'skip'}:${l.choice}${playbook ? `:${playbook}` : ''}`,
      };
    },
  });
}
