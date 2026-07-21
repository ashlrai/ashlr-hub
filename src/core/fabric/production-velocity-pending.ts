import type { AshlrConfig, Proposal } from '../types.js';

type PendingProposalConfig = Pick<AshlrConfig, 'foundry'> | undefined;

type PendingProposalFreshness = Partial<Pick<Proposal, 'createdAt' | 'status'>>;

export type ProductionVelocityRaw = boolean | Record<string, unknown> | null;

export interface PendingProposalBlockingOptions {
  now?: Date | number | string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

export function productionVelocityRaw(cfg: AshlrConfig): ProductionVelocityRaw {
  const foundry = asRecord(cfg.foundry);
  const raw = foundry?.['productionVelocity'];
  if (raw === true || raw === false) return raw;
  return asRecord(raw);
}

export function resolveProductionVelocityPendingPolicy(
  cfg: AshlrConfig,
): { enabled: boolean; stalePendingTtlHours: number } {
  const raw = productionVelocityRaw(cfg);
  const rawObj = asRecord(raw);
  const enabled = raw === true || (
    rawObj !== null &&
    rawObj['enabled'] !== false &&
    rawObj['profile'] !== 'off' &&
    (rawObj['enabled'] === true || rawObj['profile'] === 'resource-control')
  );
  return {
    enabled,
    stalePendingTtlHours: enabled
      ? positiveInt(rawObj?.['stalePendingTtlHours'], 24)
      : Number.POSITIVE_INFINITY,
  };
}

function productionVelocityNowMs(now: Date | number | string | undefined): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  if (typeof now === 'string') {
    const parsed = Date.parse(now);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

/** Shared stale-pending policy for queue coverage and proposal dedup authority. */
export function pendingProposalIsStaleForProductionVelocity(
  proposal: PendingProposalFreshness,
  cfg: PendingProposalConfig,
  opts?: PendingProposalBlockingOptions,
): boolean {
  if (proposal.status !== undefined && proposal.status !== 'pending') return false;
  const policy = resolveProductionVelocityPendingPolicy({ foundry: cfg?.foundry } as AshlrConfig);
  if (!policy.enabled || !Number.isFinite(policy.stalePendingTtlHours)) return false;
  if (!proposal.createdAt) return false;
  const activityMs = Date.parse(proposal.createdAt);
  if (!Number.isFinite(activityMs)) return false;
  const ageMs = Math.max(0, productionVelocityNowMs(opts?.now) - activityMs);
  return ageMs >= policy.stalePendingTtlHours * 60 * 60 * 1000;
}
