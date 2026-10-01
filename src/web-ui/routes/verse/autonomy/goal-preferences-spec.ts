import type { VerseCaps } from './control-types.js';

export const GOAL_PREFERENCE_FIELDS = [
  { key: 'maxOpenGoals', label: 'Active goals', help: 'Goals Leader can keep open at once.', defaultValue: 4 },
  { key: 'maxNewGoalsPerDay', label: 'New goals per day', help: 'New goals Leader can create each day.', defaultValue: 3 },
  { key: 'maxGoalProposalsPerMemo', label: 'New goal proposals', help: 'New goals Leader can propose in each plan or check-in.', defaultValue: 3 },
  { key: 'maxGoalsPerConductorCycle', label: 'Goals per planning pass', help: 'Goals Leader can schedule in one planning pass.', defaultValue: 3 },
] as const;

export type GoalPreferenceKey = (typeof GOAL_PREFERENCE_FIELDS)[number]['key'];
export type GoalPreferences = NonNullable<VerseCaps['goalPreferences']>;
export type GoalPreferenceValues = Pick<GoalPreferences, GoalPreferenceKey>;
export type GoalPreferenceDraft = Record<GoalPreferenceKey, { text: string; unlimited: boolean }>;

export function readGoalFocus(mode: unknown, threshold: unknown): { mode: boolean; threshold: number } | null {
  return typeof mode === 'boolean' && typeof threshold === 'number' && Number.isSafeInteger(threshold) && threshold > 0
    ? { mode, threshold } : null;
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { return Array.isArray(value) ? undefined : Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}

export type GoalPreferenceRead =
  | { state: 'ready'; values: GoalPreferenceValues; defaulted: GoalPreferenceKey[] }
  | { state: 'unsupported' | 'invalid' | 'unavailable' };

/** Absence is an older server, never an explicit no-limit choice. */
export function readGoalPreferences(raw: unknown): GoalPreferenceRead {
  if (raw === undefined) return { state: 'unsupported' };
  const source = own(raw, 'sourceState');
  if (source !== 'ready') return { state: source === 'unavailable' ? 'unavailable' : 'invalid' };
  const values = {} as GoalPreferenceValues;
  for (const field of GOAL_PREFERENCE_FIELDS) {
    const value = own(raw, field.key);
    if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) return { state: 'invalid' };
    values[field.key] = value as number | null;
  }
  const defaults = own(raw, 'defaulted');
  const defaulted: GoalPreferenceKey[] = [];
  // Bound malformed arrays and avoid invoking getters on projection metadata.
  try {
    if (Array.isArray(defaults) && defaults.length <= GOAL_PREFERENCE_FIELDS.length) {
      for (let i = 0; i < defaults.length; i++) {
        const key: unknown = Object.getOwnPropertyDescriptor(defaults, String(i))?.value;
        const field = GOAL_PREFERENCE_FIELDS.find((entry) => entry.key === key);
        if (field && values[field.key] !== null && !defaulted.includes(field.key)) defaulted.push(field.key);
      }
    }
  } catch { /* Missing default metadata never changes an explicit limit. */ }
  return { state: 'ready', values, defaulted };
}

export function goalPreferenceDraft(values: GoalPreferenceValues): GoalPreferenceDraft {
  return Object.fromEntries(GOAL_PREFERENCE_FIELDS.map((field) => [field.key, {
    text: String(values[field.key] ?? field.defaultValue), unlimited: values[field.key] === null,
  }])) as GoalPreferenceDraft;
}

export function validateGoalPreference(text: string, unlimited: boolean): { ok: true; value: number | null } | { ok: false; error: string } {
  if (unlimited) return { ok: true, value: null };
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value <= 0) return { ok: false, error: 'Enter a positive whole number, or choose No preference limit.' };
  return { ok: true, value };
}

/** Preserve omitted choices: a no-limit value is sent only after an explicit edit. */
export function goalPreferencePatch(draft: GoalPreferenceDraft, saved: GoalPreferenceValues): {
  patch: Partial<GoalPreferenceValues>; errors: Partial<Record<GoalPreferenceKey, string>>;
} {
  const patch: Partial<GoalPreferenceValues> = {};
  const errors: Partial<Record<GoalPreferenceKey, string>> = {};
  for (const field of GOAL_PREFERENCE_FIELDS) {
    const result = validateGoalPreference(draft[field.key].text, draft[field.key].unlimited);
    if (!result.ok) errors[field.key] = result.error;
    else if (result.value !== saved[field.key]) patch[field.key] = result.value;
  }
  return { patch, errors };
}
