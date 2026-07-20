/** Strict, side-effect-free selection-canary configuration resolution. */

export const SELECTION_CANARY_PROTOCOL = 'binary-uniform-v1' as const;

export type SelectionCanaryDisabledReason =
  | 'not-requested'
  | 'invalid-config'
  | 'unsupported-protocol'
  | 'gateway-disabled'
  | 'concurrent-dispatch-disabled';

export interface SelectionCanaryResolution {
  requested: boolean;
  protocol: typeof SELECTION_CANARY_PROTOCOL | null;
  eligible: boolean;
  disabledReason: SelectionCanaryDisabledReason | null;
}

export interface SelectionCanaryPrerequisites {
  gateway: boolean;
  concurrentDispatch: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function disabled(
  disabledReason: SelectionCanaryDisabledReason,
  requested = false,
  protocol: typeof SELECTION_CANARY_PROTOCOL | null = null,
): SelectionCanaryResolution {
  return { requested, protocol, eligible: false, disabledReason };
}

/**
 * Configuration eligibility only. This module has no dispatch dependency and
 * cannot activate a producer or alter route selection.
 */
export function resolveSelectionCanary(
  raw: unknown,
  prerequisites: SelectionCanaryPrerequisites,
): SelectionCanaryResolution {
  if (raw === undefined) return disabled('not-requested');
  if (!isPlainRecord(raw)) return disabled('invalid-config');
  if (Object.keys(raw).some((key) => key !== 'enabled' && key !== 'protocol')) {
    return disabled('invalid-config');
  }
  if (raw.enabled === undefined || raw.enabled === false) return disabled('not-requested');
  if (raw.enabled !== true) return disabled('invalid-config');
  if (raw.protocol !== undefined && raw.protocol !== SELECTION_CANARY_PROTOCOL) {
    return disabled(typeof raw.protocol === 'string' ? 'unsupported-protocol' : 'invalid-config', true);
  }
  if (!prerequisites.gateway) return disabled('gateway-disabled', true, SELECTION_CANARY_PROTOCOL);
  if (!prerequisites.concurrentDispatch) return disabled('concurrent-dispatch-disabled', true, SELECTION_CANARY_PROTOCOL);
  return { requested: true, protocol: SELECTION_CANARY_PROTOCOL, eligible: true, disabledReason: null };
}
