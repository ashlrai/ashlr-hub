/** Optional native update observations. The browser never receives installation authority. */
import { useSyncExternalStore } from 'react';
const phases = ['uncommissioned', 'disabled', 'checking', 'idle', 'available', 'downloading', 'staged', 'waiting-for-idle', 'waiting-for-app-quit', 'adoption-held', 'installing', 'installed', 'current', 'failed'] as const;
export interface DesktopUpdateState {
  phase: typeof phases[number]; enabled: boolean; version: string | null;
  bytesReceived: number; bytesTotal: number | null; reason: string | null;
}
interface UpdateBridge { getState?: () => unknown; refresh?: () => boolean }
function bridge(): UpdateBridge | undefined {
  return (window as unknown as { __ASHLR_DESKTOP__?: { updates?: UpdateBridge } }).__ASHLR_DESKTOP__?.updates;
}
export function isDesktopUpdateState(raw: unknown): raw is DesktopUpdateState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const v = raw as Record<string, unknown>;
  return phases.includes(v['phase'] as DesktopUpdateState['phase']) && typeof v['enabled'] === 'boolean' &&
    (v['version'] === null || (typeof v['version'] === 'string' && v['version'].length <= 32 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(v['version']))) &&
    Number.isSafeInteger(v['bytesReceived']) && (v['bytesReceived'] as number) >= 0 &&
    (v['bytesTotal'] === null || (Number.isSafeInteger(v['bytesTotal']) && (v['bytesTotal'] as number) > 0 && (v['bytesTotal'] as number) <= 512 * 1024 * 1024 && (v['bytesReceived'] as number) <= (v['bytesTotal'] as number))) &&
    (v['bytesReceived'] as number) <= 512 * 1024 * 1024 &&
    (v['reason'] === null || (typeof v['reason'] === 'string' && /^[a-z][a-z0-9-]{0,95}$/u.test(v['reason'])));
}
let cached: DesktopUpdateState | null | undefined;
let listening = false;
const listeners = new Set<() => void>();
function received(event: Event) {
  const next = (event as CustomEvent<unknown>).detail;
  if (!isDesktopUpdateState(next)) return;
  cached = next; for (const notify of [...listeners]) notify();
}
function subscribe(notify: () => void) {
  if (!listening) { window.addEventListener('ashlr:update-state', received); listening = true; }
  listeners.add(notify); return () => { listeners.delete(notify); };
}
export function getDesktopUpdateState(): DesktopUpdateState | null {
  if (cached == null) {
    try { const raw = bridge()?.getState?.(); cached = isDesktopUpdateState(raw) ? raw : null; } catch { cached = null; }
  }
  return cached;
}
export function refreshDesktopUpdates(): boolean {
  try { return bridge()?.refresh?.() === true; } catch { return false; }
}
export function useDesktopUpdates(): DesktopUpdateState | null {
  return useSyncExternalStore(subscribe, getDesktopUpdateState, () => null);
}
export function resetDesktopUpdatesForTests(): void {
  if (listening) window.removeEventListener('ashlr:update-state', received);
  listening = false; cached = undefined; listeners.clear();
}
