/**
 * Resident service installation has no production authority in this release.
 * This boundary is intentionally unconditional and must run before mutation.
 */
export const RESIDENT_SERVICE_AUTHORITY_DENIAL =
  'resident service install/reinstall/repair/restart authority is unavailable';

export const RESIDENT_SERVICE_DORMANT_RUNTIME_GUIDANCE =
  'No setup state was inspected or changed. Compiled daemon and conductor trust roots are empty, '
  + 'so non-dry daemon and conductor execution is dormant. Use owner-invoked `ashlr run` or '
  + '`ashlr swarm` for admitted work, or `ashlr daemon start --once --dry-run` for observation; '
  + 'existing services support status and uninstall only.';

export function assertResidentServiceInstallAuthorized(): void {
  throw new Error(RESIDENT_SERVICE_AUTHORITY_DENIAL);
}
