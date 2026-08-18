/**
 * Resident service installation has no production authority in this release.
 * This boundary is intentionally unconditional and must run before mutation.
 */
export const RESIDENT_SERVICE_AUTHORITY_DENIAL =
  'resident service install/reinstall/repair/restart authority is unavailable';

export const RESIDENT_SERVICE_ONE_SHOT_GUIDANCE =
  'No setup state was inspected or changed. Use admitted one-shot workflows such as '
  + '`ashlr daemon start --once`; existing services support status and uninstall only.';

export function assertResidentServiceInstallAuthorized(): void {
  throw new Error(RESIDENT_SERVICE_AUTHORITY_DENIAL);
}
