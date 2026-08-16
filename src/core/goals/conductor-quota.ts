/**
 * Final provider-contact quota boundary for signed one-shot goal execution.
 *
 * The durable quota authority added for daemon/best-of-N is not yet threaded
 * through every provider contact made by advanceGoal/runSwarm. Treating an
 * advisory pre-check as a reservation would create a race and false accounting,
 * so production remains fail-closed until that exact reservation is carried to
 * those contact sites.
 */

export interface GoalConductorQuotaDecision {
  launchAuthorized: boolean;
  reason: string;
}

export function reserveGoalConductorProviderQuota(): GoalConductorQuotaDecision {
  return {
    launchAuthorized: false,
    reason: 'goal-conductor-durable-quota-authority-unavailable',
  };
}
