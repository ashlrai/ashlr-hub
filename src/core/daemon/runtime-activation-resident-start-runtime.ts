/**
 * Frozen production adapter for M521.
 *
 * The privileged broker does not exist in this release. Runtime input cannot
 * register roots, replace this adapter, or turn canonical acknowledgement
 * evidence into start authority.
 */

import {
  RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY,
  type RuntimeActivationResidentStartTrustRootV1,
} from './runtime-activation-resident-start-protocol.js';

export const RUNTIME_ACTIVATION_RESIDENT_START_TRUST_ROOTS:
readonly Readonly<RuntimeActivationResidentStartTrustRootV1>[] = Object.freeze([]);

export const NATIVE_HOSTILE_PROCESS_CAS_UNAVAILABLE =
  'native-hostile-process-cas-unavailable' as const;

export interface RuntimeActivationResidentStartUnavailableResultV1 {
  ok: false;
  reason: typeof NATIVE_HOSTILE_PROCESS_CAS_UNAVAILABLE;
  authority: typeof RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY;
  trustRootCount: 0;
  acknowledgementAccepted: false;
  serviceStarted: false;
  serviceEnabledChanged: false;
  pointerChanged: false;
  providerEffectsUnblocked: false;
}

function unavailable(): RuntimeActivationResidentStartUnavailableResultV1 {
  return {
    ok: false,
    reason: NATIVE_HOSTILE_PROCESS_CAS_UNAVAILABLE,
    authority: RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY,
    trustRootCount: 0,
    acknowledgementAccepted: false,
    serviceStarted: false,
    serviceEnabledChanged: false,
    pointerChanged: false,
    providerEffectsUnblocked: false,
  };
}

export const runtimeActivationResidentStartRuntime = Object.freeze({
  roots: RUNTIME_ACTIVATION_RESIDENT_START_TRUST_ROOTS,
  requestNativeResidentStart: unavailable,
});
