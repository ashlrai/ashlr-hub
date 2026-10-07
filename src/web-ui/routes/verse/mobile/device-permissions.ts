/**
 * routes/verse/mobile/device-permissions.ts — what THIS device may do, said
 * out loud, and the two seams the remote transport plugs into.
 *
 * The phone app uses exactly the web UI's token model (data/auth-store.ts):
 *
 *   READ  — the HttpOnly read-session cookie (15 min, silently renewed from
 *           the in-memory read token). Every screen needs it.
 *   ACT   — the raw mutation token, memory-only, in a 20-minute idle hold,
 *           sent as `x-ashlr-token` on every POST. Never stored.
 *
 * So "can this phone act?" has three answers:
 *
 *   'unavailable' — the server was started without dispatch, or the device's
 *                   scopes say read-only. Action controls are HIDDEN: showing
 *                   a button that can only fail is a lie about the device.
 *   'locked'      — acting is possible but the token is not held. Controls
 *                   show; the first one asks for the token (after its
 *                   confirmation, never before — guard-store.ts).
 *   'unlocked'    — the hold is live.
 *
 * TRANSPORT SEAMS (the relay / tunnel / pairing work lands separately):
 *
 *  - registerDeviceScopes({ read, act, label }) — a paired device's token
 *    scopes. A read-only pairing must make `act` 'unavailable' even on a
 *    dispatch-enabled server. Absent (today), scopes come from the session.
 *  - registerStepUpProvider(fn) — called before any irreversible or
 *    autonomy-widening action (Land, Veto, Start fleet, Stop fleet, Delete).
 *    Resolve false to refuse. Absent (today), the held mutation token IS the
 *    step-up, exactly as on the desktop.
 *
 * Neither seam can widen anything: scopes only ever REMOVE `act`, and a
 * step-up provider only ever adds a refusal before the unchanged
 * confirm → token → POST path.
 */
import { useSyncExternalStore } from 'react';
import { useAuthPhase, useMutationHold } from '../../../data/hooks.js';

export type ActPermission = 'unlocked' | 'locked' | 'unavailable';

export interface DeviceScopes {
  read: boolean;
  act: boolean;
  /** How the transport names this device ("Mason's iPhone"), shown on More. */
  label?: string;
  /** An act grant does not imply the remote gateway has mounted writes. */
  gatewayWritesEnabled?: boolean;
}

export interface DevicePermissions {
  read: boolean;
  act: ActPermission;
  /** Why acting is unavailable or locked, in operator language; null when unlocked. */
  actReason: string | null;
  /** Where the answer came from: this browser session, or a paired device's scopes. */
  source: 'session' | 'device';
  deviceLabel: string | null;
}

export interface PermissionInput {
  authenticated: boolean;
  /** Bootstrap's `dispatchEnabled`; null while it has not answered. */
  dispatchEnabled: boolean | null;
  holdsMutation: boolean;
  scopes: DeviceScopes | null;
}

export function resolveDevicePermissions(input: PermissionInput): DevicePermissions {
  const { authenticated, dispatchEnabled, holdsMutation, scopes } = input;
  const read = authenticated && (scopes?.read ?? true);
  const base = { read, source: scopes ? ('device' as const) : ('session' as const), deviceLabel: scopes?.label ?? null };
  if (!read) return { ...base, act: 'unavailable', actReason: 'This device is not signed in to your Mac.' };
  if (scopes?.gatewayWritesEnabled === false) return { ...base, act: 'unavailable', actReason: 'The phone gateway is read-only. Actions are available on your Mac.' };
  if (scopes && !scopes.act) return { ...base, act: 'unavailable', actReason: 'This device was paired read-only. Pair it again with act permission to approve or start work.' };
  if (dispatchEnabled === null) return { ...base, act: 'unavailable', actReason: 'Checking whether this Mac allows actions. Wait for it to answer.' };
  if (dispatchEnabled === false) return { ...base, act: 'unavailable', actReason: 'Your Mac started Phantom without dispatch, so nothing can be changed from here. Run `ashlr verse` on the Mac to act.' };
  if (!holdsMutation) return { ...base, act: 'locked', actReason: 'Actions ask for the mutation token `ashlr verse` printed. It stays in memory for 20 idle minutes, never on disk.' };
  return { ...base, act: 'unlocked', actReason: null };
}

export { canShowActions } from './mobile-context.js';

// ---------------------------------------------------------------------------
// Device scopes (transport seam)
// ---------------------------------------------------------------------------

let scopes: DeviceScopes | null = null;
const scopeListeners = new Set<() => void>();

export function registerDeviceScopes(next: DeviceScopes | null): void {
  scopes = next;
  for (const l of [...scopeListeners]) l();
}

function subscribeScopes(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => scopeListeners.delete(listener);
}

function getScopes(): DeviceScopes | null {
  return scopes;
}

export function useDevicePermissions(dispatchEnabled: boolean | null): DevicePermissions {
  const phase = useAuthPhase();
  const hold = useMutationHold();
  const current = useSyncExternalStore(subscribeScopes, getScopes, getScopes);
  return resolveDevicePermissions({ authenticated: phase === 'authenticated', dispatchEnabled, holdsMutation: hold.hasHold, scopes: current });
}

// ---------------------------------------------------------------------------
// Step-up (transport seam)
// ---------------------------------------------------------------------------

export interface StepUpRequest {
  /** The button the operator pressed: "Land", "Stop the fleet". */
  action: string;
  /** Cannot be undone from the phone (a merge, a veto, the kill switch). */
  irreversible: boolean;
}

export type StepUpProvider = (request: StepUpRequest) => Promise<boolean>;

let stepUp: StepUpProvider | null = null;

export function registerStepUpProvider(provider: StepUpProvider | null): void {
  stepUp = provider;
}

/**
 * Ask the registered provider; true = proceed. With none registered the
 * answer is true: the mutation token (asked for next, if not held) is the
 * step-up this build has. A provider that throws refuses.
 */
export async function requestStepUp(request: StepUpRequest): Promise<boolean> {
  if (!stepUp || !request.irreversible) return true;
  try {
    return (await stepUp(request)) === true;
  } catch {
    return false;
  }
}
