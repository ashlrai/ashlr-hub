/**
 * Frozen production adapter for the M568 stopped-consumer v2 protocol.
 *
 * The protected native broker does not exist in this release. Runtime input
 * cannot register roots, replace this adapter, consume a permit, or turn
 * canonical permit evidence into pointer/rollback authority.
 */

import {
  RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY,
  type RuntimeActivationStoppedConsumerV2TrustRoot,
} from './runtime-activation-stopped-consumer-v2-protocol.js';

export const RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_TRUST_ROOTS:
readonly Readonly<RuntimeActivationStoppedConsumerV2TrustRoot>[] = Object.freeze([]);

export const NATIVE_VERSION_GENERAL_STOPPED_SELECTION_UNAVAILABLE =
  'native-version-general-stopped-selection-unavailable' as const;

export interface RuntimeActivationStoppedConsumerV2UnavailableResult {
  ok: false;
  reason: typeof NATIVE_VERSION_GENERAL_STOPPED_SELECTION_UNAVAILABLE;
  authority: typeof RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY;
  trustRootCount: 0;
  permitAccepted: false;
  selectionAuthorized: false;
  pointerChanged: false;
  plistChanged: false;
  serviceStarted: false;
  serviceEnabledChanged: false;
  acknowledgementAccepted: false;
  dispatchAuthorized: false;
  rollbackAuthorized: false;
  providerEffectsUnblocked: false;
}

function unavailable(): RuntimeActivationStoppedConsumerV2UnavailableResult {
  return {
    ok: false,
    reason: NATIVE_VERSION_GENERAL_STOPPED_SELECTION_UNAVAILABLE,
    authority: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY,
    trustRootCount: 0,
    permitAccepted: false,
    selectionAuthorized: false,
    pointerChanged: false,
    plistChanged: false,
    serviceStarted: false,
    serviceEnabledChanged: false,
    acknowledgementAccepted: false,
    dispatchAuthorized: false,
    rollbackAuthorized: false,
    providerEffectsUnblocked: false,
  };
}

export const runtimeActivationStoppedConsumerV2Runtime = Object.freeze({
  roots: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_TRUST_ROOTS,
  requestStoppedSelection: unavailable,
});
