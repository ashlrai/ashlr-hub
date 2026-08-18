/**
 * Resident service installation authority. Default (no `ashlr activation
 * init` + `ashlr activation grant install` ever run) is EXACTLY the old
 * unconditional denial. Once an operator explicitly grants the `install`
 * scope (see activation-permit.ts), this gate consults that real, signed,
 * expiring, revocable standing grant instead. Every check is audited.
 */
import { audit } from '../sandbox/audit.js';
import { daemonActivationScopeGranted } from './activation-permit.js';

export const RESIDENT_SERVICE_AUTHORITY_DENIAL =
  'resident service install/reinstall/repair/restart authority is unavailable';

export const RESIDENT_SERVICE_ONE_SHOT_GUIDANCE =
  'No setup state was inspected or changed. Use admitted one-shot workflows such as '
  + '`ashlr daemon start --once`; existing services support status and uninstall only.';

export function assertResidentServiceInstallAuthorized(): void {
  const check = daemonActivationScopeGranted('install');
  audit({
    action: 'daemon-activation:install-check',
    repo: null,
    sandboxId: null,
    summary: `resident service install authority ${check.granted ? 'authorized' : 'denied'}: ${check.reason}`,
    result: check.granted ? 'ok' : 'refused',
  });
  if (!check.granted) {
    throw new Error(`${RESIDENT_SERVICE_AUTHORITY_DENIAL}: ${check.reason}`);
  }
}
