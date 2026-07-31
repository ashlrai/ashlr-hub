export interface ResidentServiceInstallAdmission {
  authorized: boolean;
  reason: string;
}

/**
 * Resident service authority is intentionally unavailable until a separately
 * reviewed, externally authenticated, bounded permit exists. Proposal-once
 * permits cannot be widened into resident authority.
 */
export function residentServiceInstallAdmission(): ResidentServiceInstallAdmission {
  return {
    authorized: false,
    reason: 'resident-activation-authority-unavailable',
  };
}
