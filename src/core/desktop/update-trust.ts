/** Publisher trust, commissioned through a normal qualified installation. Never accept a staged key. */
import type { UpdateTrust } from './update-manifest.js';

export const UPDATER_PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFBNDI1NEZGRjRDODVCOEIKUldTTFc4ajAvMVJDcW1MQy84cHNXNUtPYTNDM0s1K2tDc1A2VUxCL1JwWHQzQzl6M3JqQ3I3SmwK";
const trust: UpdateTrust = Object.freeze({
  publicKey: UPDATER_PUBLIC_KEY,
  repository: Object.freeze({
    fullName: 'ashlrai/ashlr-hub', repositoryId: 1263526319,
    repositoryNodeId: 'R_kgDOS0_hrw', ownerLogin: 'ashlrai',
    ownerId: 258113726, ownerNodeId: 'O_kgDOD2KAvg',
  }),
  channel: 'stable', platform: 'darwin-aarch64',
});

export function getDesktopUpdateTrust(): UpdateTrust { return trust; }
