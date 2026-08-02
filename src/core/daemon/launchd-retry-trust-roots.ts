/**
 * Repository-owned trust policy for external launchd retry-epoch authorities.
 *
 * Production intentionally ships with no roots. A trusted root and external
 * monotonic CAS adapter require a separate security and deployment decision.
 */

export const LAUNCHD_RETRY_TRUST_PROTOCOL = 'ashlr-launchd-retry-trust-v1' as const;
export const LAUNCHD_RETRY_SIGNER_ROLE = 'launchd-retry-epoch-authority' as const;
export const LAUNCHD_RETRY_SIGNATURE_ALGORITHM = 'ed25519' as const;

export interface LaunchdRetryTrustRoot {
  keyId: string;
  publicKeySpki: string;
  signerRole: typeof LAUNCHD_RETRY_SIGNER_ROLE;
  signatureAlgorithm: typeof LAUNCHD_RETRY_SIGNATURE_ALGORITHM;
  notBeforeMs: number;
  notAfterMs: number;
  revokedAtMs: number | null;
}

export interface LaunchdRetryTrustPolicy {
  schemaVersion: 1;
  protocol: typeof LAUNCHD_RETRY_TRUST_PROTOCOL;
  policyGeneration: number;
  roots: readonly LaunchdRetryTrustRoot[];
}

export const LAUNCHD_RETRY_TRUST_POLICY: LaunchdRetryTrustPolicy = Object.freeze({
  schemaVersion: 1,
  protocol: LAUNCHD_RETRY_TRUST_PROTOCOL,
  policyGeneration: 0,
  roots: Object.freeze([]),
});

/**
 * Return the deployment-owned retry trust policy.
 *
 * This intentionally has no config, environment, transport, or caller input.
 * Tests replace this module at the loader boundary rather than widening the
 * production controller options with injectable trust roots.
 */
export function readLaunchdRetryTrustPolicy(): LaunchdRetryTrustPolicy {
  return LAUNCHD_RETRY_TRUST_POLICY;
}
