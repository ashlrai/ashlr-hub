/** Display-only native credit metadata; never quota, cash accounting or dispatch authority. */
export interface CodexCredits { hasCredits: boolean; unlimited: boolean; balance: string | null; spendControlReached?: boolean | null }

function own(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && 'value' in field ? field.value : undefined;
}

/** Preserve native decimal units exactly; malformed or incomplete reports are unknown. */
export function normalizeCodexCredits(value: unknown): CodexCredits | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length < 3 || keys.length > 4 || !keys.every((key) => typeof key === 'string' && ['hasCredits', 'unlimited', 'balance', 'spendControlReached'].includes(key))) return null;
    const hasCredits = own(value, 'hasCredits'); const unlimited = own(value, 'unlimited'); const balance = own(value, 'balance');
    if (typeof hasCredits !== 'boolean' || typeof unlimited !== 'boolean' ||
      !(balance === null || typeof balance === 'string' && balance.length <= 64 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(balance) && Number.isFinite(Number(balance)))) return null;
    const spend = own(value, 'spendControlReached');
    if (spend !== undefined && spend !== null && typeof spend !== 'boolean') return null;
    if (Object.hasOwn(value, 'spendControlReached') && spend === undefined) return null;
    return { hasCredits, unlimited, balance, ...(Object.hasOwn(value, 'spendControlReached') ? { spendControlReached: spend as boolean | null } : {}) };
  } catch { return null; }
}

export function codexCreditsAvailable(value: CodexCredits | null): boolean {
  return value !== null && value.hasCredits && (value.unlimited || value.balance === null || /[1-9]/.test(value.balance));
}

/** Read only one selected native bucket. An authoritative map never borrows legacy credits. */
export function readCodexNativeCredits(payload: unknown, bucketId: string): CodexCredits | null {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const map = own(payload, 'rateLimitsByLimitId');
    const bucket = Object.hasOwn(payload, 'rateLimitsByLimitId')
      ? map && typeof map === 'object' && !Array.isArray(map) ? own(map, bucketId) : null
      : own(payload, 'rateLimits');
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return null;
    const id = own(bucket, 'limitId');
    if (!Object.hasOwn(payload, 'rateLimitsByLimitId') && id !== bucketId || id !== undefined && id !== bucketId) return null;
    const credits = normalizeCodexCredits(own(bucket, 'credits'));
    if (!credits) return null;
    const spend = own(bucket, 'spendControlReached');
    const denial = own(bucket, 'rateLimitReachedType');
    return { ...credits, spendControlReached: typeof denial === 'string' &&
      ['workspace_owner_credits_depleted', 'workspace_member_credits_depleted', 'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached'].includes(denial)
      ? true : typeof spend === 'boolean' ? spend : null };
  } catch { return null; }
}
