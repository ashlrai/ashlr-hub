/** Operator planning/lane preferences, separate from signed authority and provider capacity. */
export const LEADER_PREFERENCE_KEYS = ['maxFullRunsPerDay', 'maxTotalRunsPerDay', 'maxGrokLanes'] as const;
export type LeaderPreferenceKey = typeof LEADER_PREFERENCE_KEYS[number];
export type LeaderPreferenceConfig = Partial<Record<LeaderPreferenceKey, number | null>>;
export const LEADER_PREFERENCE_DEFAULTS = Object.freeze({ maxFullRunsPerDay: 3, maxTotalRunsPerDay: 8, maxGrokLanes: 4 });

export interface ResolvedLeaderPreferences extends Record<LeaderPreferenceKey, number | null> {
  defaulted: LeaderPreferenceKey[];
  sourceState: 'ready' | 'invalid' | 'unavailable';
  errors: string[];
}

export type LeaderPreferenceParse =
  | { ok: true; preferences: LeaderPreferenceConfig }
  | { ok: false; errors: string[] };

/** Data-only validation shared by configuration and partial operator updates. */
export function parseLeaderPreferences(raw: unknown, allowEmpty = false): LeaderPreferenceParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['leaderPreferences must be an object'] };
  }
  try {
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return { ok: false, errors: ['leaderPreferences must be a plain object'] };
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(descriptors);
    if (!allowEmpty && keys.length === 0) return { ok: false, errors: ['leaderPreferences must name at least one preference'] };
    const preferences: LeaderPreferenceConfig = {};
    for (const key of keys) {
      if (typeof key !== 'string' || !(LEADER_PREFERENCE_KEYS as readonly string[]).includes(key)) {
        return { ok: false, errors: ['leaderPreferences contains an unknown key'] };
      }
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor) || !descriptor.enumerable) return { ok: false, errors: [`leaderPreferences.${key} must be a data field`] };
      const value: unknown = descriptor.value;
      if (value !== null && !(typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) {
        return { ok: false, errors: [`leaderPreferences.${key} must be a positive safe integer or null`] };
      }
      preferences[key as LeaderPreferenceKey] = value as number | null;
    }
    return { ok: true, preferences };
  } catch {
    return { ok: false, errors: ['leaderPreferences could not be inspected'] };
  }
}

function defaults(checkinsEnabled: boolean): Record<LeaderPreferenceKey, number> {
  return { ...LEADER_PREFERENCE_DEFAULTS,
    maxTotalRunsPerDay: checkinsEnabled ? LEADER_PREFERENCE_DEFAULTS.maxTotalRunsPerDay : LEADER_PREFERENCE_DEFAULTS.maxFullRunsPerDay };
}

export function unavailableLeaderPreferences(checkinsEnabled = true): ResolvedLeaderPreferences {
  return { ...defaults(checkinsEnabled), defaulted: [], sourceState: 'unavailable',
    errors: ['Leader preferences could not be read'] };
}

export function resolveLeaderPreferences(
  cfg?: { foundry?: { leaderPreferences?: unknown } } | null,
  opts: { checkinsEnabled?: boolean } = {},
): ResolvedLeaderPreferences {
  const fallback = defaults(opts.checkinsEnabled !== false);
  if (cfg?.foundry !== undefined && (typeof cfg.foundry !== 'object' || cfg.foundry === null || Array.isArray(cfg.foundry))) {
    return { ...fallback, defaulted: [], sourceState: 'invalid', errors: ['foundry must be an object'] };
  }
  const raw = cfg?.foundry?.leaderPreferences;
  const parsed = raw === undefined ? { ok: true as const, preferences: {} } : parseLeaderPreferences(raw, true);
  if (!parsed.ok) return { ...fallback, defaulted: [], sourceState: 'invalid', errors: parsed.errors };
  return { ...fallback, ...parsed.preferences,
    defaulted: LEADER_PREFERENCE_KEYS.filter((key) => !(key in parsed.preferences)), sourceState: 'ready', errors: [] };
}

export function leaderPreferencesReady(value: ResolvedLeaderPreferences): boolean {
  return value.sourceState === 'ready' && LEADER_PREFERENCE_KEYS.every((key) =>
    value[key] === null || typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key]! > 0);
}
