/**
 * routes/verse/mobile/mobile-context.ts — what every phone screen reads from
 * the shell: this device's permissions, whether the Mac is reachable, the
 * shell's one activity loop, and navigation. One provider (MobileRuntime), so
 * a screen never opens a second activity poll or recomputes permissions.
 *
 * Until the runtime's chunk lands (it downloads in parallel with the session
 * probe — MobileShell.tsx) the value is BOOT_CONTEXT: nothing known, nothing
 * actionable. Actions stay hidden until the device's permissions are known.
 */
import { createContext, useContext } from 'react';
import type { ActivityState } from '../shell/useActivity.js';
import type { Reachability } from './connectivity.js';
import type { DevicePermissions } from './device-permissions.js';
import { navigateMobile, type MobileRoute, type NavigateOptions } from './mobile-router.js';

export interface MobileContextValue {
  /** False until the runtime (activity loop, permissions) has loaded. */
  ready: boolean;
  permissions: DevicePermissions;
  reachability: Reachability;
  activity: ActivityState;
  navigate: (route: MobileRoute, options?: NavigateOptions) => void;
  /** Needs-you items still waiting (acted-on ones hidden at once); null = unknown. */
  needsCount: number | null;
  /** Agents running a turn now; null = unknown. */
  workingCount: number | null;
  /** Re-poll activity now (pull-to-refresh on any screen). */
  refreshActivity: () => Promise<void>;
}

export const BOOT_CONTEXT: MobileContextValue = {
  ready: false,
  permissions: { read: false, act: 'unavailable', actReason: null, source: 'session', deviceLabel: null },
  reachability: 'connecting',
  activity: { status: 'idle', data: null, updatedAt: null, error: null },
  navigate: navigateMobile,
  needsCount: null,
  workingCount: null,
  refreshActivity: () => Promise.resolve(),
};

/**
 * Whether an action control should render at all: never when the device
 * cannot act (dispatch off, read-only pairing, not yet known). Here rather
 * than in device-permissions.ts so first-paint code can ask without loading it.
 */
export function canShowActions(permissions: Pick<DevicePermissions, 'act'>): boolean {
  return permissions.act !== 'unavailable';
}

export const MobileContext = createContext<MobileContextValue>(BOOT_CONTEXT);

export function useMobile(): MobileContextValue {
  return useContext(MobileContext);
}
