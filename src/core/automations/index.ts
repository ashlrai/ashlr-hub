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
import { AutomationInputError, canonicalPlaybookRef } from './validate.js';

export * from './types.js';
export { AutomationInputError, canonicalPlaybookRef } from './validate.js';
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

/** Refs that name no playbook (src/core/playbooks: saved versions + built-ins). */
async function missingPlaybooks(refs: readonly (string | null | undefined)[]): Promise<string[]> {
  const wanted = [...new Set(refs.filter((r): r is string => typeof r === 'string' && r !== ''))];
  if (wanted.length === 0) return [];
  const [{ getPlaybook }, { parsePlaybookRefText }] = await Promise.all([import('../playbooks/store.js'), import('../playbooks/types.js')]);
  const missing: string[] = [];
  for (const ref of wanted) {
    const canonical = canonicalPlaybookRef(ref);
    const parsed = canonical ? parsePlaybookRefText(canonical) : null;
    if (!parsed || !(await getPlaybook(parsed.id, parsed.version))) missing.push(ref);
  }
  return missing;
}

/** A named playbook must exist when the automation is saved — a lane would refuse it at launch anyway. */
async function assertPlaybooksExist(input: Record<string, unknown>): Promise<void> {
  const triage = input['triage'] as { playbooks?: unknown } | null | undefined;
  const refs = [input['playbookId'], ...(Array.isArray(triage?.playbooks) ? triage!.playbooks : [])].filter((r): r is string => typeof r === 'string' && r !== '');
  // Malformed refs get validation's own sentence (saveAutomation), not "no such playbook".
  if (refs.some((r) => canonicalPlaybookRef(r) === null)) return;
  const missing = await missingPlaybooks(refs);
  if (missing.length > 0) {
    throw new AutomationInputError(`No playbook ${missing.map((m) => `"${m.slice(0, 60)}"`).join(', ')} — create it in Verse → Playbooks or \`ashlr playbook new\` first.`);
  }
}

/** Throws AutomationInputError (plain sentence) on an invalid definition, an existing id, or an unknown playbook. */
export async function createAutomation(input: AutomationInput | Record<string, unknown>): Promise<AutomationV1> {
  await assertPlaybooksExist(input as Record<string, unknown>);
  return (await saveAutomation(input, { mode: 'create' })).automation;
}

/** Merge `patch` over the stored definition and re-validate it whole. Null when the id is unknown. */
export async function updateAutomation(id: string, patch: Partial<AutomationInput> | Record<string, unknown>): Promise<AutomationV1 | null> {
  const existing = await getAutomation(id);
  if (!existing) return null;
  const { v: _v, createdAt: _c, updatedAt: _u, ...current } = existing;
  const { id: _ignored, ...rest } = patch as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current, ...rest, id };
  await assertPlaybooksExist(merged);
  return (await saveAutomation(merged, { mode: 'update' })).automation;
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
