export type ServiceActivity =
  | 'running'
  | 'scheduler-active-unverified'
  | 'inactive'
  | 'unknown';

export interface ServiceActivityInput {
  running: boolean;
  runtimeState?: 'running' | 'queued' | 'ready' | 'disabled' | 'stopped' | 'unknown';
  platformSpec: string;
}

/**
 * Keep native scheduler activity distinct from proven daemon liveness.
 * Task Scheduler's Running/Queued states do not prove the daemon process is live.
 */
export function serviceActivity(status: ServiceActivityInput): ServiceActivity {
  if (status.running) return 'running';
  if (
    status.platformSpec === 'schtasks' &&
    (status.runtimeState === 'running' || status.runtimeState === 'queued')
  ) {
    return 'scheduler-active-unverified';
  }
  if (status.runtimeState === 'unknown') return 'unknown';
  return 'inactive';
}
