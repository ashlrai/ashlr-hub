/**
 * Durable provider-contact authority for the signed one-shot goal conductor.
 *
 * One atomic transaction pessimistically reserves the planner contact plus the
 * twelve contacts allowed by the signed run's maxSteps budget. Reservations
 * are never refunded: ambiguity or an unused ticket consumes capacity safely.
 */

import { createHash } from 'node:crypto';
import type { AshlrConfig, ProviderInferenceQuotaSession } from '../types.js';
import { reserveFleetQuotaUses } from '../fleet/quota.js';

export const GOAL_CONDUCTOR_PROVIDER_TICKET_COUNT = 13;
const ATTEMPT_DOMAIN = 'ashlr:goal-conductor-provider-attempt:v1';
const QUOTA_WINDOWS_MS: Readonly<Record<string, number>> = Object.freeze({
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '5h': 5 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
});

export interface GoalConductorQuotaBinding {
  permitId: string;
  goalId: string;
  milestoneId: string;
  goalDigest: string;
  projectPath: string;
}

export type GoalConductorQuotaDecision =
  | {
      launchAuthorized: true;
      reason: 'goal-conductor-provider-quota-reserved';
      attemptId: string;
      providerQuota: ProviderInferenceQuotaSession;
    }
  | {
      launchAuthorized: false;
      reason: string;
    };

/** A typed terminal refusal that must never enter model fallback/retry logic. */
export class GoalConductorQuotaRefusal extends Error {
  readonly code = 'goal-conductor-provider-quota-refused';

  constructor(reason: string) {
    super(reason);
    this.name = 'GoalConductorQuotaRefusal';
  }
}

export function isGoalConductorQuotaRefusal(value: unknown): value is GoalConductorQuotaRefusal {
  return value instanceof GoalConductorQuotaRefusal || (
    typeof value === 'object' && value !== null &&
    (value as { code?: unknown }).code === 'goal-conductor-provider-quota-refused'
  );
}

function deriveAttemptId(binding: GoalConductorQuotaBinding): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      ATTEMPT_DOMAIN,
      binding.permitId,
      binding.goalId,
      binding.milestoneId,
      binding.goalDigest,
      binding.projectPath,
    ]))
    .digest('hex');
  return `goal-attempt-${digest}`;
}

function ticketId(attemptId: string, ordinal: number): string {
  return `${attemptId}.provider.${ordinal.toString().padStart(2, '0')}`;
}

function createClaimSession(
  attemptId: string,
  expiresAtMs: number,
): ProviderInferenceQuotaSession {
  let next = 0;
  let expired = false;
  return Object.freeze({
    attemptId,
    claimNext(): string {
      if (expired || Date.now() >= expiresAtMs) {
        expired = true;
        throw new GoalConductorQuotaRefusal('goal-conductor-provider-ticket-session-expired');
      }
      if (next >= GOAL_CONDUCTOR_PROVIDER_TICKET_COUNT) {
        throw new GoalConductorQuotaRefusal('goal-conductor-provider-ticket-cap-exhausted');
      }
      const claimed = ticketId(attemptId, next);
      next += 1;
      return claimed;
    },
  });
}

/**
 * Reserve the complete 13-contact set before any provider inference.
 *
 * `unlimited` is deliberately a refusal: without a configured builtin limit,
 * the quota ledger provides no durable reservation or replay evidence.
 */
export function reserveGoalConductorProviderQuota(
  cfg: AshlrConfig,
  binding: GoalConductorQuotaBinding,
): GoalConductorQuotaDecision {
  const configuredWindow = cfg.foundry?.limits?.builtin?.window;
  const windowMs = typeof configuredWindow === 'string'
    ? QUOTA_WINDOWS_MS[configuredWindow]
    : undefined;
  if (windowMs === undefined) {
    return {
      launchAuthorized: false,
      reason: 'goal-conductor-provider-quota-window-invalid',
    };
  }
  const attemptId = deriveAttemptId(binding);
  const requests = Array.from(
    { length: GOAL_CONDUCTOR_PROVIDER_TICKET_COUNT },
    (_, ordinal) => ({ backend: 'builtin' as const, dispatchId: ticketId(attemptId, ordinal) }),
  );
  const reservedAtMs = Date.now();
  const reservation = reserveFleetQuotaUses(requests, cfg);
  if (!reservation.launchAuthorized || reservation.kind !== 'reserved') {
    return {
      launchAuthorized: false,
      reason: `goal-conductor-provider-quota-${reservation.kind}`,
    };
  }
  if (
    reservation.reservations.length !== GOAL_CONDUCTOR_PROVIDER_TICKET_COUNT ||
    reservation.reservations.some((receipt) =>
      receipt.backend !== 'builtin' || receipt.status !== 'reserved')
  ) {
    return {
      launchAuthorized: false,
      reason: 'goal-conductor-provider-quota-receipt-invalid',
    };
  }
  return {
    launchAuthorized: true,
    reason: 'goal-conductor-provider-quota-reserved',
    attemptId,
    providerQuota: createClaimSession(attemptId, reservedAtMs + windowMs),
  };
}
