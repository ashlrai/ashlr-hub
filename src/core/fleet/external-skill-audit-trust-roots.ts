/**
 * Repository-owned trust roots for independent external-skill audit verifiers.
 *
 * Production intentionally ships with no roots. Provisioning a root is a
 * separate security and deployment decision; request data can never extend
 * this registry.
 */

export const EXTERNAL_SKILL_AUDIT_TRUST_PROTOCOL =
  'ashlr-external-skill-audit-trust-v1' as const;
export const EXTERNAL_SKILL_AUDIT_SIGNER_ROLE =
  'external-skill-audit-verifier' as const;
export const EXTERNAL_SKILL_AUDIT_SIGNATURE_ALGORITHM = 'ed25519' as const;

export interface ExternalSkillAuditTrustRoot {
  keyId: string;
  publicKeySpki: string;
  signerRole: typeof EXTERNAL_SKILL_AUDIT_SIGNER_ROLE;
  signatureAlgorithm: typeof EXTERNAL_SKILL_AUDIT_SIGNATURE_ALGORITHM;
  auditPolicyDigest: string;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
}

export interface ExternalSkillAuditTrustPolicy {
  schemaVersion: 1;
  protocol: typeof EXTERNAL_SKILL_AUDIT_TRUST_PROTOCOL;
  policyGeneration: number;
  roots: readonly ExternalSkillAuditTrustRoot[];
}

export const EXTERNAL_SKILL_AUDIT_TRUST_POLICY: ExternalSkillAuditTrustPolicy = Object.freeze({
  schemaVersion: 1,
  protocol: EXTERNAL_SKILL_AUDIT_TRUST_PROTOCOL,
  policyGeneration: 0,
  roots: Object.freeze([]),
});
