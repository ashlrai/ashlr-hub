import type { LaunchdRetryExternalAuthority } from './launchd-retry-controller.js';

/**
 * Production retry transport composition point.
 *
 * No environment variable, config file, local key, or implicit endpoint may
 * populate this authority. Provisioning an authenticated external CAS requires
 * a separate deployment-owned implementation and review.
 */
export async function loadLaunchdRetryExternalAuthority(): Promise<
  LaunchdRetryExternalAuthority | undefined
> {
  return undefined;
}
