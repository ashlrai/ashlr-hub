/**
 * Legacy resident service installation has no production authority. This
 * boundary is intentionally unconditional and must run before mutation: every
 * `ashlr daemon install`, `setup`, `onboard`, `worker setup`, `dashboard` and
 * `update` service path stays denied.
 *
 * The one admitted path is `ashlr authority resident start`, which installs
 * the macOS resident service only through daemon/service.ts
 * `installResidentService` with a single-use capability minted by
 * authority/resident.ts under an active, Touch-ID-signed standing grant
 * (docs/RESIDENT-RUNTIME.md). Nothing here grants that capability.
 */
export const RESIDENT_SERVICE_AUTHORITY_DENIAL =
  'resident service install/reinstall/repair/restart authority is unavailable';

export const RESIDENT_SERVICE_DORMANT_RUNTIME_GUIDANCE =
  'No setup state was inspected or changed. Compiled daemon and conductor trust roots are empty, '
  + 'so permit-based non-dry daemon and conductor execution is dormant; resident work runs only under '
  + 'an active standing grant, installed with `ashlr authority resident start`. Use owner-invoked '
  + '`ashlr run` or `ashlr swarm` for admitted work, or `ashlr daemon start --once --dry-run` for '
  + 'observation; through this path existing services support status and uninstall only.';

export function assertResidentServiceInstallAuthorized(): void {
  throw new Error(RESIDENT_SERVICE_AUTHORITY_DENIAL);
}
