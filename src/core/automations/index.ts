/**
 * Automations — the public API (Verse routes, `ashlr automations`, the
 * Leader). Everything that changes an automation or fires one goes through
 * here; nothing here bypasses a lane's own entry point or gate (lanes.ts).
 *
 *   listAutomations / getAutomation
 *   createAutomation(input)            validated; refuses an existing id
 *   updateAutomation(id, patch)        merge + re-validate the whole definition
 *   enableAutomation / disableAutomation / deleteAutomation
 *   fireAutomation(id, { dryRun, repo, text })
 *   runAutomationsTick()               the scheduler's one call per tick
 *   receiveWebhook / receiveTelegramTask / reviewFiring
 *   automationsOverview()              the Verse view's read model
 */
import {
  deleteAutomation as deleteStoredAutomation,
  readAutomations,
  saveAutomation,
  setAutomationEnabled,
} from './store.js';
import type { AutomationInput, AutomationV1 } from './types.js';

export * from './types.js';
export { AutomationInputError } from './validate.js';
export { AUTOMATION_TEMPLATES, automationTemplate } from './templates.js';
export { parseRrule, nextOccurrence, describeRrule } from './rrule.js';
export {
  automationsOverview,
  automationStats,
  fireAutomation,
  lastBlockedReason,
  receiveTelegramTask,
  receiveWebhook,
  reviewFiring,
  runAutomationsTick,
  triggerSummary,
  type AutomationEngineDeps,
  type AutomationsTickSummary,
  type ReviewResult,
  type WebhookResult,
} from './engine.js';
export type { AutomationDecider, AutomationTriageAnswer, AutomationTriageInput } from './triage.js';
export type { AutomationGh } from './github.js';
export type { AutomationLaneDeps, LaneOutcome, LaneStatus } from './lanes.js';
export { readAutomationJournal, readAutomationState, type AutomationJournalRecord } from './store.js';

export async function listAutomations(): Promise<AutomationV1[]> {
  return (await readAutomations()).automations;
}

export async function getAutomation(id: string): Promise<AutomationV1 | null> {
  return (await readAutomations()).automations.find((a) => a.id === id) ?? null;
}

/** Throws AutomationInputError (plain sentence) on an invalid definition or an existing id. */
export async function createAutomation(input: AutomationInput | Record<string, unknown>): Promise<AutomationV1> {
  return (await saveAutomation(input, { mode: 'create' })).automation;
}

/** Merge `patch` over the stored definition and re-validate it whole. Null when the id is unknown. */
export async function updateAutomation(id: string, patch: Partial<AutomationInput> | Record<string, unknown>): Promise<AutomationV1 | null> {
  const existing = await getAutomation(id);
  if (!existing) return null;
  const { v: _v, createdAt: _c, updatedAt: _u, ...current } = existing;
  const { id: _ignored, ...rest } = patch as Record<string, unknown>;
  return (await saveAutomation({ ...current, ...rest, id }, { mode: 'update' })).automation;
}

export function enableAutomation(id: string): Promise<AutomationV1 | null> {
  return setAutomationEnabled(id, true);
}

export function disableAutomation(id: string): Promise<AutomationV1 | null> {
  return setAutomationEnabled(id, false);
}

export function deleteAutomation(id: string): Promise<boolean> {
  return deleteStoredAutomation(id);
}
