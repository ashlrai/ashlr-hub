/**
 * Repository-owned roots allowed to approve verifier execution trust policies.
 *
 * Production intentionally ships with no roots. Provisioning is a separate
 * security and deployment decision; request data cannot extend this registry.
 */

export const VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_PROTOCOL_V1 =
  'ashlr-verifier-execution-policy-approval-trust-v1' as const;
export const VERIFIER_EXECUTION_POLICY_APPROVER_ROLE =
  'verifier-execution-policy-approver' as const;
export const VERIFIER_EXECUTION_POLICY_APPROVAL_SIGNATURE_ALGORITHM = 'ed25519' as const;

export type VerifierExecutionPolicyPlatformV1 = 'darwin' | 'linux' | 'win32';
export type VerifierExecutionPolicyArchitectureV1 = 'arm64' | 'x64';
export type VerifierExecutionPolicyBackendV1 =
  | 'linux-namespace-cgroup-broker'
  | 'macos-virtualization-framework-broker'
  | 'windows-appcontainer-job-broker';

export interface VerifierExecutionPolicyApprovalRootV1 {
  keyId: string;
  publicKeySpki: string;
  role: typeof VERIFIER_EXECUTION_POLICY_APPROVER_ROLE;
  signatureAlgorithm: typeof VERIFIER_EXECUTION_POLICY_APPROVAL_SIGNATURE_ALGORITHM;
  fleetDigest: string;
  repositoryDigest: string;
  environmentDigest: string;
  allowedPlatforms: readonly VerifierExecutionPolicyPlatformV1[];
  allowedArchitectures: readonly VerifierExecutionPolicyArchitectureV1[];
  allowedBackends: readonly VerifierExecutionPolicyBackendV1[];
  minimumApprovedPolicyGeneration: number;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
}

export interface VerifierExecutionPolicyApprovalTrustPolicyV1 {
  schemaVersion: 1;
  protocol: typeof VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_PROTOCOL_V1;
  policyGeneration: number;
  roots: readonly VerifierExecutionPolicyApprovalRootV1[];
}

export const VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY:
VerifierExecutionPolicyApprovalTrustPolicyV1 = Object.freeze({
  schemaVersion: 1,
  protocol: VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_PROTOCOL_V1,
  policyGeneration: 0,
  roots: Object.freeze([]),
});
