import type { VerseCaps } from './control-types.js';
import { validateGoalPreference } from './goal-preferences-spec.js';

export const LEADER_PREFERENCE_FIELDS = [
  { key: 'maxFullRunsPerDay', label: 'Full plans per day', help: 'Daily full planning runs. These also count toward total runs.' },
  { key: 'maxTotalRunsPerDay', label: 'Total runs per day', help: 'Daily planning runs and check-ins combined.' },
  { key: 'maxGrokLanes', label: 'Parallel Grok lanes', help: 'Maximum Grok lanes Leader may request. Available accounts and execution slots still determine what runs.' },
] as const;
export type LeaderPreferenceKey = typeof LEADER_PREFERENCE_FIELDS[number]['key'];
export type LeaderPreferences = NonNullable<VerseCaps['leaderPreferences']>;
export type LeaderPreferenceValues = Pick<LeaderPreferences, LeaderPreferenceKey>;
export type LeaderPreferenceDraft = Record<LeaderPreferenceKey, { text: string; unlimited: boolean }>;
export type LeaderPreferenceRead = { state: 'ready'; values: LeaderPreferenceValues; defaulted: LeaderPreferenceKey[] }
  | { state: 'unsupported' | 'invalid' | 'unavailable' };

function own(raw: unknown, key: string): unknown {
  try { return raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.getOwnPropertyDescriptor(raw, key)?.value : undefined; }
  catch { return undefined; }
}

export function readLeaderPreferences(raw: unknown): LeaderPreferenceRead {
  if (raw === undefined) return { state: 'unsupported' };
  const source = own(raw, 'sourceState');
  if (source !== 'ready') return { state: source === 'unavailable' ? 'unavailable' : 'invalid' };
  const values = {} as LeaderPreferenceValues;
  for (const field of LEADER_PREFERENCE_FIELDS) {
    const value = own(raw, field.key);
    if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) return { state: 'invalid' };
    values[field.key] = value as number | null;
  }
  const defaulted: LeaderPreferenceKey[] = [];
  const metadata = own(raw, 'defaulted');
  try {
    if (Array.isArray(metadata) && metadata.length <= LEADER_PREFERENCE_FIELDS.length) {
      for (let i = 0; i < metadata.length; i++) {
        const key: unknown = Object.getOwnPropertyDescriptor(metadata, String(i))?.value;
        const field = LEADER_PREFERENCE_FIELDS.find((entry) => entry.key === key);
        if (field && values[field.key] !== null && !defaulted.includes(field.key)) defaulted.push(field.key);
      }
    }
  } catch { /* Unknown default metadata never changes explicit preferences. */ }
  return { state: 'ready', values, defaulted };
}

export function leaderPreferenceDraft(values: LeaderPreferenceValues): LeaderPreferenceDraft {
  // A null-to-finite edit requires a number; never guess whether check-ins are enabled.
  return Object.fromEntries(LEADER_PREFERENCE_FIELDS.map(({ key }) => [key, {
    text: values[key] === null ? '' : String(values[key]), unlimited: values[key] === null,
  }])) as LeaderPreferenceDraft;
}

export function leaderPreferencePatch(draft: LeaderPreferenceDraft, saved: LeaderPreferenceValues) {
  const patch: Partial<LeaderPreferenceValues> = {};
  const errors: Partial<Record<LeaderPreferenceKey, string>> = {};
  for (const { key } of LEADER_PREFERENCE_FIELDS) {
    const result = validateGoalPreference(draft[key].text, draft[key].unlimited);
    if (!result.ok) errors[key] = result.error;
    else if (result.value !== saved[key]) patch[key] = result.value;
  }
  return { patch, errors };
}
