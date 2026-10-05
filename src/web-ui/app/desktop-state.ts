/** Optional desktop preference store; loaded only by desktop controls. */
import { useSyncExternalStore } from 'react';
interface DesktopBridge {
  getState?: () => unknown;
  refreshState?: () => boolean;
  setPreference?: (name: DesktopPreference, value: boolean) => boolean;
}
function bridge(): DesktopBridge | undefined {
  return (window as unknown as { __ASHLR_DESKTOP__?: DesktopBridge }).__ASHLR_DESKTOP__;
}

// ===========================================================================
// Desktop state — Settings ▸ Desktop (V3.10, C8)
// ===========================================================================

/** Preferences Settings ▸ Desktop may change (desktop_prefs.rs `PrefsPatch`). */
export type DesktopPreference = 'globalHotkey' | 'notifications' | 'automaticAwake';

/**
 * What the desktop app reports (desktop_prefs.rs `DesktopStateView`). Every
 * string is the shell's own copy — nothing from the server.
 */
export type { PowerState } from '../routes/verse/power/power-state.js';

export interface DesktopState {
  /** Absent on older shells; null means native power status unavailable. */
  power?: unknown;
  hotkey: {
    /** The operator's choice. */
    enabled: boolean;
    /** Whether macOS actually gave Ashlr the chord. */
    registered: boolean;
    /** Display form, e.g. "⌃⌥Space". */
    accelerator: string;
    /** Why `registered` is false while `enabled` is true; null otherwise. */
    error: string | null;
  };
  notifications: {
    enabled: boolean;
    /**
     * `native` — a signed build, banners come from Ashlr.
     * `script` — an unsigned build, banners come through osascript and show
     * as Script Editor (say so beside the toggle).
     */
    delivery: 'native' | 'script';
  };
}

const DESKTOP_STATE_EVENT = 'ashlr:desktop-state';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Boundary check: the value crossed from another runtime. */
export function isDesktopState(value: unknown): value is DesktopState {
  if (!isRecord(value) || !isRecord(value['hotkey']) || !isRecord(value['notifications'])) return false;
  const h = value['hotkey'];
  const n = value['notifications'];
  return (
    typeof h['enabled'] === 'boolean' &&
    typeof h['registered'] === 'boolean' &&
    typeof h['accelerator'] === 'string' &&
    h['accelerator'].length > 0 &&
    h['accelerator'].length <= 32 &&
    (h['error'] === null || (typeof h['error'] === 'string' && h['error'].length <= 300)) &&
    typeof n['enabled'] === 'boolean' &&
    (n['delivery'] === 'native' || n['delivery'] === 'script')
  );
}

// One module-level listener feeds a cached snapshot, so readers (and
// useSyncExternalStore, which needs a STABLE snapshot) never see a stale or
// freshly-copied object.
let cachedState: DesktopState | null | undefined;
let listening = false;
const stateListeners = new Set<(state: DesktopState) => void>();

function readBridgeState(): DesktopState | null {
  try {
    const raw = bridge()?.getState?.();
    return isDesktopState(raw) ? raw : null;
  } catch {
    return null;
  }
}

function onDesktopState(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isDesktopState(detail)) return;
  cachedState = detail;
  for (const listener of [...stateListeners]) listener(detail);
}

function ensureListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener(DESKTOP_STATE_EVENT, onDesktopState);
}

/** Request a fresh authenticated host observation without supplying any activity. */
export function refreshDesktopState(): boolean {
  try { return bridge()?.refreshState?.() === true; } catch { return false; }
}

/** The latest desktop state, or null in a browser (and before native answered). */
export function getDesktopState(): DesktopState | null {
  ensureListening();
  if (cachedState === undefined || cachedState === null) cachedState = readBridgeState();
  return cachedState;
}

/** Called with every new state native sends. Returns an unsubscribe function. */
export function subscribeDesktopState(handler: (state: DesktopState) => void): () => void {
  ensureListening();
  stateListeners.add(handler);
  return () => {
    stateListeners.delete(handler);
  };
}

/**
 * Ask the desktop app to change a preference. True when the request was sent
 * (a desktop bridge exists), false in a browser. The answer arrives as a new
 * state — e.g. a hotkey another app holds comes back
 * `{ enabled: true, registered: false, error }` — so render from state, never
 * from the value you asked for.
 */
export function setDesktopPreference(name: DesktopPreference, value: boolean): boolean {
  if (name !== 'globalHotkey' && name !== 'notifications' && name !== 'automaticAwake') return false;
  if (typeof value !== 'boolean') return false;
  try {
    return bridge()?.setPreference?.(name, value) === true;
  } catch {
    return false;
  }
}

function subscribeStore(onChange: () => void): () => void {
  return subscribeDesktopState(() => onChange());
}

/**
 * React: the live desktop state, or null in a browser. Settings ▸ Desktop
 * renders its hotkey and notification rows from this and hides them (or says
 * "available in the desktop app") when it is null.
 */
export function useDesktopState(): DesktopState | null {
  return useSyncExternalStore(subscribeStore, getDesktopState, () => null);
}

/** Tests only: forget the cached state and the module listener. */
export function resetDesktopStateForTests(): void {
  if (listening) window.removeEventListener(DESKTOP_STATE_EVENT, onDesktopState);
  listening = false;
  cachedState = undefined;
  stateListeners.clear();
}
