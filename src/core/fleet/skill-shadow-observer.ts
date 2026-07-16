/** Observe-only signed skill selection. Never changes executable inputs. */

import type { RouteSnapshot, SkillCard, SkillUseEvent } from '../types.js';
import {
  SKILL_RETRIEVAL_POLICY_VERSION,
  selectShadowSkills,
  type ShadowSkillSelection,
  type SkillRetrievalQuery,
} from './skill-retrieval.js';
import { recordSkillUseEvent } from './skill-records.js';
import {
  buildShadowSkillUseEvent,
  type StrongSkillAttemptIdentity,
} from './skill-use-identity.js';

export interface ObserveShadowSkillsInput {
  cards: readonly SkillCard[];
  query: SkillRetrievalQuery;
  identity: StrongSkillAttemptIdentity;
  selectedAt: string;
  route: Pick<RouteSnapshot, 'backend' | 'tier' | 'model'>;
}

export interface ObserveShadowSkillsResult {
  selection: ShadowSkillSelection;
  events: SkillUseEvent[];
}

export interface ObserveShadowSkillsDeps {
  select?: typeof selectShadowSkills;
  buildEvent?: typeof buildShadowSkillUseEvent;
  record?: typeof recordSkillUseEvent;
}

function isDormantSelection(selection: ShadowSkillSelection): boolean {
  if (
    selection.mode !== 'shadow' ||
    selection.policyVersion !== SKILL_RETRIEVAL_POLICY_VERSION ||
    !Array.isArray(selection.selected) ||
    !Array.isArray(selection.selectedSkillIds) ||
    selection.selected.length !== selection.selectedSkillIds.length
  ) return false;
  return selection.selected.length === 0 && selection.selectedSkillIds.length === 0;
}

export function observeShadowSkills(
  input: ObserveShadowSkillsInput,
  deps: ObserveShadowSkillsDeps = {},
): ObserveShadowSkillsResult {
  const select = deps.select ?? selectShadowSkills;
  const buildEvent = deps.buildEvent ?? buildShadowSkillUseEvent;
  const record = deps.record ?? recordSkillUseEvent;
  try {
    const selection = select(input.cards, input.query);
    if (!isDormantSelection(selection)) throw new Error('skill release verifier unavailable');
    const events = selection.selected.flatMap((skill) => {
      const event = buildEvent({
        identity: input.identity,
        selectedAt: input.selectedAt,
        skill,
        route: input.route,
      });
      return event ? [event] : [];
    });
    if (events.length > 0) record(events);
    return { selection, events };
  } catch {
    return {
      selection: {
        mode: 'shadow',
        policyVersion: SKILL_RETRIEVAL_POLICY_VERSION,
        consideredCount: 0,
        eligibleCount: 0,
        selectedSkillIds: [],
        selected: [],
      },
      events: [],
    };
  }
}
