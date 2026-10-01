/** Operator preferences, not signed authority. null explicitly removes a preference limit. */
export const GOAL_PREFERENCE_KEYS = [
  'maxOpenGoals', 'maxNewGoalsPerDay', 'maxGoalProposalsPerMemo', 'maxGoalsPerConductorCycle',
] as const;
export type GoalPreferenceKey = typeof GOAL_PREFERENCE_KEYS[number];
export type GoalPreferenceConfig = Partial<Record<GoalPreferenceKey, number | null>>;
export const GOAL_PREFERENCE_DEFAULTS = Object.freeze({
  maxOpenGoals: 4, maxNewGoalsPerDay: 3, maxGoalProposalsPerMemo: 3, maxGoalsPerConductorCycle: 3,
});
/** Transport limits remain finite even when an operator removes a business preference. */
export const GOAL_MEMO_PROTOCOL = Object.freeze({ maxMemoActions: 24, maxMemoRawChars: 256 * 1024 });
export interface ResolvedGoalPreferences extends Record<GoalPreferenceKey, number | null> {
  defaulted: GoalPreferenceKey[];
  sourceState: 'ready' | 'invalid' | 'unavailable';
  errors: string[];
  protocol: typeof GOAL_MEMO_PROTOCOL;
}
export type GoalPreferenceParse =
  | { ok: true; preferences: GoalPreferenceConfig }
  | { ok: false; errors: string[] };

/** Strict data-only object validation shared by configuration and the partial HTTP update. */
export function parseGoalPreferences(raw: unknown, allowEmpty = false): GoalPreferenceParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['goalPreferences must be an object'] };
  }
  try {
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return { ok: false, errors: ['goalPreferences must be a plain object'] };
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(descriptors);
    if (!allowEmpty && keys.length === 0) return { ok: false, errors: ['goalPreferences must name at least one preference'] };
    const preferences: GoalPreferenceConfig = {};
    for (const key of keys) {
      if (typeof key !== 'string' || !(GOAL_PREFERENCE_KEYS as readonly string[]).includes(key)) {
        return { ok: false, errors: ['goalPreferences contains an unknown key'] };
      }
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor) || !descriptor.enumerable) return { ok: false, errors: [`goalPreferences.${key} must be a data field`] };
      const value: unknown = descriptor.value;
      if (value !== null && !(typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) {
        return { ok: false, errors: [`goalPreferences.${key} must be a positive safe integer or null`] };
      }
      preferences[key as GoalPreferenceKey] = value as number | null;
    }
    return { ok: true, preferences };
  } catch {
    return { ok: false, errors: ['goalPreferences could not be inspected'] };
  }
}

export function unavailableGoalPreferences(): ResolvedGoalPreferences {
  return { ...GOAL_PREFERENCE_DEFAULTS, defaulted: [], sourceState: 'unavailable',
    errors: ['Goal preferences could not be read'], protocol: GOAL_MEMO_PROTOCOL };
}

export function resolveGoalPreferences(cfg?: { foundry?: { goalPreferences?: unknown } } | null): ResolvedGoalPreferences {
  if (cfg?.foundry !== undefined && (typeof cfg.foundry !== 'object' || cfg.foundry === null || Array.isArray(cfg.foundry))) {
    return { ...GOAL_PREFERENCE_DEFAULTS, defaulted: [], sourceState: 'invalid', errors: ['Goal preference configuration is invalid'], protocol: GOAL_MEMO_PROTOCOL };
  }
  const raw = cfg?.foundry?.goalPreferences;
  const parsed = raw === undefined ? { ok: true as const, preferences: {} } : parseGoalPreferences(raw, true);
  if (!parsed.ok) return { ...GOAL_PREFERENCE_DEFAULTS, defaulted: [], sourceState: 'invalid', errors: parsed.errors, protocol: GOAL_MEMO_PROTOCOL };
  const values = { ...GOAL_PREFERENCE_DEFAULTS, ...parsed.preferences };
  return { ...values, defaulted: GOAL_PREFERENCE_KEYS.filter((key) => !(key in parsed.preferences)),
    sourceState: 'ready', errors: [], protocol: GOAL_MEMO_PROTOCOL };
}

/** Validate observations without coercing unknown into a business quota or zero. */
export function knownGoalCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function goalPreferencesReady(value: ResolvedGoalPreferences): boolean {
  return value.sourceState === 'ready' && GOAL_PREFERENCE_KEYS.every((key) =>
    value[key] === null || typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key]! > 0);
}
