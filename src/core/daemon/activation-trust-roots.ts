/** Immutable production activation trust roots. This module contains no I/O. */

export interface DaemonActivationTrustRoot {
  keyId: string;
  publicKeyPem: string;
}

/**
 * Provisioning a production trust root requires a reviewed source change.
 * No environment variable, config field, CLI argument, or writable trust file
 * can add authority at runtime.
 */
export const DAEMON_ACTIVATION_TRUST_ROOTS:
readonly Readonly<DaemonActivationTrustRoot>[] = Object.freeze([]);
