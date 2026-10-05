/** Optional native power DTO. Decode only when the desktop power surface loads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface PowerState {
  automatic: boolean;
  requested: boolean;
  localRuns: number | null;
  checkedAt: number | null;
  platform: string;
  powerSource: 'ac' | 'battery' | null;
  idleSleepSeconds: number | null;
  settingsCheckedAt: number | null;
  error: string | null;
}

export function isPowerState(value: unknown): value is PowerState {
  if (!isRecord(value)) return false;
  return typeof value['automatic'] === 'boolean' && typeof value['requested'] === 'boolean' &&
    (value['localRuns'] === null || (typeof value['localRuns'] === 'number' && Number.isSafeInteger(value['localRuns']) && value['localRuns'] >= 0)) &&
    (value['checkedAt'] === null || (typeof value['checkedAt'] === 'number' && Number.isSafeInteger(value['checkedAt']) && value['checkedAt'] > 0)) &&
    (value['settingsCheckedAt'] === null || (typeof value['settingsCheckedAt'] === 'number' && Number.isSafeInteger(value['settingsCheckedAt']) && value['settingsCheckedAt'] > 0)) &&
    (value['powerSource'] === null || value['powerSource'] === 'ac' || value['powerSource'] === 'battery') &&
    (value['idleSleepSeconds'] === null || (typeof value['idleSleepSeconds'] === 'number' && Number.isSafeInteger(value['idleSleepSeconds']) && value['idleSleepSeconds'] >= 0)) &&
    typeof value['platform'] === 'string' && ['macos', 'windows', 'linux'].includes(value['platform']) &&
    (value['error'] === null || (typeof value['error'] === 'string' && value['error'].length <= 300));
}
