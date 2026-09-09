import type { ResourceAccountConnection } from '../../../core/resources/connection-types.js';

type SummaryReason =
  | 'measured-reference'
  | 'historical'
  | 'invalid-ceiling'
  | 'unavailable-evidence'
  | 'unverified-quota';

export interface AccountUsageSummary {
  state: 'known' | 'unavailable';
  headroomPercent: number | null;
  limitingWindowIds: string[];
  atOrAboveCeiling: boolean | null;
  nextResetAt: string | null;
  reason: SummaryReason;
}

function unavailable(reason: Exclude<SummaryReason, 'measured-reference'>): AccountUsageSummary {
  return {
    state: 'unavailable',
    headroomPercent: null,
    limitingWindowIds: [],
    atOrAboveCeiling: null,
    nextResetAt: null,
    reason,
  };
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

export function summarizeAccountUsage(
  account: ResourceAccountConnection,
  options: { sampledAt: string; ceilingPercent: number | null; historical?: boolean },
): AccountUsageSummary {
  if (options.historical === true) return unavailable('historical');

  const ceiling = options.ceilingPercent;
  if (typeof ceiling !== 'number' || !Number.isInteger(ceiling) || ceiling < 0 || ceiling > 100) {
    return unavailable('invalid-ceiling');
  }

  const sampledAt = timestamp(options.sampledAt);
  const observedAt = timestamp(account?.observedAt);
  const expiresAt = timestamp(account?.expiresAt);
  if (
    !account ||
    account.state !== 'observed' ||
    account.authentication !== 'signed-in' ||
    account.health !== 'reachable' ||
    sampledAt === null || observedAt === null || expiresAt === null ||
    observedAt > sampledAt || expiresAt <= sampledAt
  ) {
    return unavailable('unavailable-evidence');
  }

  const windows = account.windows;
  if (!Array.isArray(windows) || windows.length === 0 || windows.length > 64) {
    return unavailable('unverified-quota');
  }

  const seen = new Set<string>();
  let maximum = -Infinity;
  let limitingWindowIds: string[] = [];
  let earliestReset = Infinity;
  let nextResetAt: string | null = null;

  for (const window of windows) {
    if (window === null || typeof window !== 'object') return unavailable('unverified-quota');
    const id = window.id;
    const usage = window.usedPercent;
    const resetsAt = window.resetsAt;
    const resetTime = timestamp(resetsAt);
    if (
      typeof id !== 'string' || id.trim().length === 0 || seen.has(id) ||
      typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0 || usage > 100 ||
      resetTime === null || resetTime <= sampledAt ||
      'nativeReport' in window
    ) {
      return unavailable('unverified-quota');
    }
    seen.add(id);
    if (usage > maximum) {
      maximum = usage;
      limitingWindowIds = [id];
    } else if (usage === maximum) {
      limitingWindowIds.push(id);
    }
    if (resetTime < earliestReset) {
      earliestReset = resetTime;
      nextResetAt = resetsAt;
    }
  }

  const headroom = Math.round(Math.max(0, ceiling - maximum) * 100) / 100;
  return {
    state: 'known',
    headroomPercent: headroom === 0 ? 0 : headroom,
    limitingWindowIds: limitingWindowIds.sort(),
    atOrAboveCeiling: maximum >= ceiling,
    nextResetAt,
    reason: 'measured-reference',
  };
}
