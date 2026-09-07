/** The independent samples needed for task-desk ordering; not a process heartbeat. */
export interface ResourceTaskOrderRow {
  readonly job?: { readonly state: string; readonly outcome?: string | null; readonly updatedAt: string };
  readonly receipt?: { readonly status: string; readonly startedAt: string };
}

const ACTIVE_STATES = new Set(['queued', 'dispatching', 'reserved', 'unresolved', 'uncertain']);

export function hasResourceTaskOccupancy(row: ResourceTaskOrderRow): boolean {
  const state = row.job?.state === 'settled'
    ? row.job.outcome ?? 'settled' : row.job?.state ?? row.receipt?.status ?? 'unknown';
  // A newer terminal supervisor sample cannot erase occupancy in a separately
  // sampled ledger. Keep it visible until both observations have settled.
  return ACTIVE_STATES.has(state) || row.receipt?.status === 'reserved' || row.receipt?.status === 'uncertain';
}

/** Occupied first, then existing supervisor/receipt timestamp precedence; ties stay stable. */
export function compareResourceTaskRows(a: ResourceTaskOrderRow, b: ResourceTaskOrderRow): number {
  const aActive = hasResourceTaskOccupancy(a);
  const bActive = hasResourceTaskOccupancy(b);
  if (aActive !== bActive) return aActive ? -1 : 1;
  return (b.job?.updatedAt ?? b.receipt?.startedAt ?? '').localeCompare(a.job?.updatedAt ?? a.receipt?.startedAt ?? '');
}
